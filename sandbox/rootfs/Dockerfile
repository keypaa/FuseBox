FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV IS_SANDBOX=yes
ENV PYTHONUNBUFFERED=1

# Unminimize + upgrade
RUN apt-get update && apt-get install -y unminimize && yes | unminimize
RUN apt-get update && apt-get upgrade -y && apt-get dist-upgrade -y

# Core tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates wget fuse3 gnupg2 git \
    graphviz build-essential zip unzip file bc \
    netcat-openbsd libxml2-utils libnss3-tools \
    p11-kit p11-kit-modules \
    python3 python3-pip python3-dev python3-venv \
    python3-wheel python3-uno pipx \
    libcairo2-dev pkg-config libgl1 libglib2.0-0 \
    default-jre-headless \
    fonts-crosextra-carlito fonts-crosextra-caladea \
    fonts-noto-cjk fonts-noto-cjk-extra fonts-dejavu \
    fonts-liberation2 fonts-texgyre \
    texlive-latex-base texlive-fonts-recommended \
    texlive-latex-recommended texlive-xetex \
    texlive-science texlive-pictures latexmk \
    ffmpeg pandoc poppler-utils qpdf \
    imagemagick wkhtmltopdf \
    tesseract-ocr tesseract-ocr-eng pdftk \
    libreoffice-writer libreoffice-impress \
    libreoffice-calc libreoffice-java-common ure-java

# Node 22 from NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# Playwright browser dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 \
    libatspi2.0-0t64 libcups2t64 libdrm2 libgbm1 \
    libgtk-3-0t64 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libxshmfence1 \
    xvfb fonts-noto-color-emoji fonts-unifont \
    xfonts-cyrillic xfonts-scalable fonts-liberation \
    fonts-ipafont-gothic fonts-wqy-zenhei \
    fonts-tlwg-loma-otf fonts-freefont-ttf

# Users
RUN useradd -m -u 999 -s /bin/bash claude 2>/dev/null || true
RUN useradd -m -u 1000 -s /bin/bash ubuntu 2>/dev/null || true

# Python packages
ENV PIP_ROOT_USER_ACTION=ignore
ENV PIP_CACHE_DIR=/home/claude/.cache/pip
RUN pip install --break-system-packages --no-cache-dir \
    numpy pandas scipy scikit-learn scikit-image matplotlib seaborn \
    opencv-python mediapipe Pillow imageio Wand \
    pypdf pdfplumber pdfminer.six pdf2image pikepdf pypdfium2 \
    camelot-py tabula-py python-docx python-pptx reportlab img2pdf \
    Flask requests beautifulsoup4 playwright lxml \
    onnxruntime pytesseract markdownify mistune sympy \
    networkx graphviz cryptography psutil openpyxl xlsxwriter \
    unoserver pyoo sounddevice mkdocs-material grip \
    magika markitdown openpyxl tabulate

# Install uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# NPM globals
RUN npm install -g playwright typescript ts-node tsx \
    react react-dom pptxgenjs pdf-lib sharp marked \
    @mermaid-js/mermaid-cli docx markdown-pdf graphviz

# Playwright browsers + deps
RUN playwright install chromium
RUN playwright install-deps chromium

# Chrome symlink (Anthropic pattern)
RUN ln -sf /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome /opt/google/chrome/chrome 2>/dev/null || true

# Working directory
WORKDIR /home/claude
ENV HOME=/home/claude

RUN apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*
