#!/usr/bin/env python3
"""学习系统 V1：本地播放器、学习跟踪、内容总结、Case 回写。"""

from __future__ import annotations

import hashlib
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import requests


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
API_BASE = "https://casecenterapi.sumifcc.com"
TENANT_ID = "135300029613315100"


class CaseClient:
    def __init__(self, account: str, password: str):
        self.account = account.strip()
        self.password = password
        self.session = requests.Session()
        self.token = ""

    @property
    def headers(self):
        return {"lang": "zh-CN", "authentication": self.token, "Content-Type": "application/json"}

    def login(self):
        digest = hashlib.md5(self.password.encode("utf-8")).hexdigest()
        response = self.session.post(
            f"{API_BASE}/login",
            json={"username": self.account, "password": digest, "tenantId": TENANT_ID, "sig": ""},
            timeout=20,
        )
        data = response.json()
        if not data.get("success"):
            raise ValueError(data.get("msg") or "Case 登录失败")
        self.token = str(data["data"]["token"])

    def get_case(self, case_index: str):
        response = self.session.get(
            f"{API_BASE}/case/by/index",
            params={"caseIndex": case_index},
            headers={k: v for k, v in self.headers.items() if k != "Content-Type"},
            timeout=20,
        )
        data = response.json()
        if not data.get("success"):
            raise ValueError(data.get("msg") or "查询 Case 失败")
        return data["data"]

    def add_comment(self, case_id: str, content: str):
        response = self.session.post(
            f"{API_BASE}/comment",
            json={
                "topicId": str(case_id), "replyCommentId": "0", "atUserIdList": [],
                "tag": 1, "content": content, "fileIdList": [],
            },
            headers=self.headers,
            timeout=30,
        )
        data = response.json()
        if not data.get("success"):
            raise ValueError(data.get("msg") or "写入 Case 评论失败")
        return data.get("data") or {}

    def get_comments(self, case_id: str):
        response = self.session.post(
            f"{API_BASE}/comment/list",
            json={"topicId": str(case_id), "current": 1, "size": 500},
            headers=self.headers,
            timeout=30,
        )
        data = response.json()
        if not data.get("success"):
            raise ValueError(data.get("msg") or "读取 Case 评论失败")
        return (data.get("data") or {}).get("records") or []


def extract_learning_urls(case: dict, comments: list[dict]):
    """从 Case 概述和评论中提取去重后的 http(s) 学习入口。"""
    url_re = re.compile(r"https?://[^\s<>\"'，。；、）)】]+", re.I)
    found, seen = [], set()

    def collect(text: str, source: str):
        for raw in url_re.findall(text or ""):
            url = raw.rstrip(".,;!?，。；！？")
            if url in seen:
                continue
            seen.add(url)
            path = urlparse(url).path.lower()
            direct = path.endswith((".mp4", ".webm", ".ogg", ".m4v"))
            found.append({"url": url, "source": source, "directVideo": direct})

    collect(str(case.get("content") or ""), "Case 概述")
    for comment in comments:
        number = comment.get("commentIndex")
        collect(str(comment.get("content") or ""), f"msg#{number}" if number else "Case 评论")
    return found


def sentences(text: str):
    cleaned = re.sub(r"\s+", " ", text.strip())
    return [s.strip(" ，,。；;！？!?：:") for s in re.split(r"[。！？!?；;\n]+", cleaned) if len(s.strip()) >= 6]


def keywords(text: str, limit=12):
    """用轻量规则抽取中文知识短语；避免把一句话按固定长度硬切断。"""
    candidates = []
    for sentence in sentences(text):
        parts = re.split(r"(?:需要|必须|应当|应该|可以|能够|包括|通过|进行|以及|并且|同时|然后|如果|因此|所以|是指|是|为)", sentence)
        for part in parts:
            part = part.strip(" ，,、的了着")
            if 2 <= len(part) <= 10:
                candidates.append(part.lower())
        candidates.extend(x.lower() for x in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", sentence))
    counts = Counter(candidates)
    return [word for word, _ in sorted(counts.items(), key=lambda item: (-item[1], candidates.index(item[0])))[:limit]]


def summarize_and_quiz(text: str, learned_ratio: float):
    all_sentences = sentences(text)
    if not all_sentences:
        raise ValueError("请先粘贴至少一段字幕或讲义文本")
    cutoff = max(1, round(len(all_sentences) * max(0.01, min(1, learned_ratio))))
    learned = all_sentences[:cutoff]
    learned_text = "。".join(learned)
    keys = keywords(learned_text)
    scored = []
    for i, sentence in enumerate(learned):
        score = sum(learned_text.count(k) for k in keys if k in sentence) - i * 0.02
        scored.append((score, i, sentence))
    chosen = sorted(sorted(scored, reverse=True)[: min(5, len(scored))], key=lambda x: x[1])
    summary = [item[2] for item in chosen]

    quiz = []
    for index, sentence in enumerate(learned):
        candidates = [k for k in keys if 2 <= len(k) <= 10 and k in sentence]
        if not candidates:
            continue
        answer = candidates[0]
        prompt = sentence.replace(answer, "______", 1)
        quiz.append({"type": "填空题", "question": f"根据学习内容填空：{prompt}", "answer": answer})
        if len(quiz) >= 5:
            break
    if len(quiz) < 3:
        for sentence in learned[: 3 - len(quiz)]:
            quiz.append({"type": "判断题", "question": f"判断下述表述是否符合学习内容：{sentence}", "answer": "正确"})
    return {"summary": summary, "keywords": keys[:8], "quiz": quiz, "coveredSentences": cutoff, "totalSentences": len(all_sentences)}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        origin = self.headers.get("Origin", "")
        if origin == "null" or origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def convert_video(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 2_000_000_000:
            raise ValueError("视频文件为空或超过 2GB 限制")
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            candidates = list((Path.home() / "AppData/Local/Microsoft/WinGet/Packages").glob("Gyan.FFmpeg_*/ffmpeg-*/bin/ffmpeg.exe"))
            ffmpeg = str(candidates[0]) if candidates else ""
        if not ffmpeg:
            raise ValueError("没有找到 FFmpeg，请先安装后再转换")
        with tempfile.TemporaryDirectory(prefix="case-learning-") as folder:
            source = Path(folder) / "source.mp4"
            target = Path(folder) / "converted-h264.mp4"
            with source.open("wb") as handle:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
            result = subprocess.run([
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(target)
            ], capture_output=True, timeout=3600)
            if result.returncode != 0 or not target.exists():
                raise ValueError("视频转换失败：" + result.stderr.decode("utf-8", "replace")[-500:])
            body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            raise ValueError("请求内容过大")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_POST(self):
        try:
            route = urlparse(self.path).path
            if route == "/api/media/convert":
                return self.convert_video()
            data = self.read_json()
            if route == "/api/analyze":
                result = summarize_and_quiz(str(data.get("text", "")), float(data.get("learnedRatio", 1)))
                return self.send_json(HTTPStatus.OK, {"ok": True, **result})
            if route == "/api/case/check":
                client = CaseClient(str(data.get("account", "")), str(data.get("password", "")))
                client.login()
                case = client.get_case(str(data.get("caseIndex", "")))
                comments = client.get_comments(str(case.get("caseId")))
                urls = extract_learning_urls(case, comments)
                return self.send_json(HTTPStatus.OK, {"ok": True, "caseId": str(case.get("caseId")), "title": case.get("title", ""), "learningUrls": urls})
            if route == "/api/case/comment":
                client = CaseClient(str(data.get("account", "")), str(data.get("password", "")))
                client.login()
                case = client.get_case(str(data.get("caseIndex", "")))
                result = client.add_comment(str(case.get("caseId")), str(data.get("content", "")))
                return self.send_json(HTTPStatus.OK, {"ok": True, "commentIndex": result.get("commentIndex")})
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "接口不存在"})
        except (ValueError, requests.RequestException, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"服务器错误：{exc}"})


def main():
    parser = argparse.ArgumentParser(description="Case 学习系统")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    host, port = args.host, args.port
    print(f"学习系统 V1 已启动：http://{host}:{port}")
    if host == "0.0.0.0":
        print("局域网模式已开启：手机请访问 http://电脑局域网IP:8765")
    print("按 Ctrl+C 停止。账号和密码只用于当次请求，不会保存到磁盘。")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()

