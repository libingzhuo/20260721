FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/app.py /app/app.py
COPY learning-system /app/static
RUN pip install --no-cache-dir requests
ENV PORT=10000
EXPOSE 10000
CMD ["sh", "-c", "python app.py --host 0.0.0.0 --port ${PORT}"]
