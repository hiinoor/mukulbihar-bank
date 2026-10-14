#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if command -v python3.12 >/dev/null 2>&1; then
  PYTHON=python3.12
else
  PYTHON=python3
fi
"$PYTHON" -m venv .venv

if ! command -v cmake >/dev/null 2>&1; then
  .venv/bin/python -m pip install cmake
  CMAKE=.venv/bin/cmake
else
  CMAKE=cmake
fi

if [ ! -d vendor/whisper.cpp ]; then
  mkdir -p vendor
  git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp.git vendor/whisper.cpp
fi

mkdir -p models
if [ ! -f models/ggml-small.bin ]; then
  curl -L --fail --retry 3 --output models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
fi

"$CMAKE" -S vendor/whisper.cpp -B vendor/whisper.cpp/build -DWHISPER_BUILD_SERVER=ON -DGGML_METAL=OFF -DCMAKE_BUILD_TYPE=Release
"$CMAKE" --build vendor/whisper.cpp/build --target whisper-server -j 6 --config Release
.venv/bin/python -m pip install 'piper-tts[http]'
.venv/bin/python -m piper.download_voices --data-dir models/piper en_US-lessac-medium hi_IN-priyamvada-medium
echo 'Voice service ready. Run: npm run voice:serve'
