FROM python:3.11-slim-bookworm
WORKDIR /worker
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY download_models.py tracker.py worker.py ./
RUN python download_models.py && useradd -u 1000 -m analytics && mkdir /data && chown analytics:analytics /data
USER analytics
ENV PYTHONUNBUFFERED=1 VISITOR_DATA_DIR=/data
CMD ["python", "worker.py"]
