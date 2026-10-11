# The Anvil Python sandbox (docs/SANDBOX.md). Programs of agents run in this image.
FROM python:3.12-slim

# The base libraries. Other packages come only through the package gate.
RUN pip install --no-cache-dir \
      pandas==2.2.3 numpy==2.1.3 python-dateutil==2.9.0.post0 \
      beautifulsoup4==4.12.3 lxml==5.3.0 openpyxl==3.1.5 pydantic==2.10.3 \
  && useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox

COPY runner.py gate_proxy.py /opt/anvil/
COPY anvil /opt/anvil/sdk/anvil

ENV PYTHONPATH=/opt/anvil/sdk \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/work \
    PIP_INDEX_URL=http://anvil-gate-3141:3141/simple \
    PIP_TRUSTED_HOST=anvil-gate-3141 \
    PIP_ONLY_BINARY=:all: \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

USER 10001
WORKDIR /work
CMD ["sleep", "infinity"]
