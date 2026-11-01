#!/bin/sh
# The TV Macs have no Rust. Build the wasm here and copy it next to the page.
set -eu
cd "$(dirname "$0")"
export PATH="${HOME}/.cargo/bin:${PATH}"
cargo build --release --target wasm32-unknown-unknown
mkdir -p ../tv/games
cp target/wasm32-unknown-unknown/release/onto_games.wasm ../tv/games/number-snake.wasm
