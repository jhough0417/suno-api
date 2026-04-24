#!/bin/bash
cd "$(dirname "$0")"
unset NODE_ENV
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm run dev
