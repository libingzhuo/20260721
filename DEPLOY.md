# 云端后台部署

本项目可部署到支持 Docker 的云平台。推荐 Render：

[一键部署到 Render](https://render.com/deploy?repo=https://github.com/libingzhuo/20260721)

## 部署后

1. 等待状态变为 Live。
2. 打开 Render 提供的 HTTPS 地址。
3. 手机和电脑均可直接使用。
4. 服务包含 Case 登录/读取/评论回写和 H.265 转 H.264。

## 注意

- Case 密码仅用于当次请求，不保存到磁盘。
- H.265 转码消耗 CPU；免费实例可能较慢并会休眠。
- 不要把 Case 账号密码写进 GitHub 文件或环境变量。
