FROM mcr.microsoft.com/playwright/python:v1.48.0-noble

WORKDIR /app

RUN pip install --no-cache-dir \
    scrapling \
    curl_cffi \
    fastapi \
    "uvicorn[standard]" \
    playwright \
    patchright \
    browserforge \
    msgspec

RUN python3 -m playwright install chromium
RUN python3 -m patchright install chromium

RUN python3 -m browserforge update

COPY app.py .

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]