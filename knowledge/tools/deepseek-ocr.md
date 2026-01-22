---
name: DeepSeek-OCR
description: An OCR system that compresses long text into vision tokens, achieving 97% decoding precision at 10× compression and 60% accuracy at 20× compression
url: https://github.com/deepseek-ai/DeepSeek-OCR
category: ocr
tags: [compression, vision-tokens, optical-ocr]
last_updated: 2025-10-20
---

# DeepSeek-OCR

An OCR system that compresses long text into vision tokens, literally turning paragraphs into pixels. The model achieves 97% decoding precision at 10× compression and still manages 60% accuracy even at 20× compression.

## Key Features

- Compresses text into vision tokens for efficient processing
- Achieves 97% decoding precision at 10× compression
- Maintains 60% accuracy even at 20× compression
- Outperforms GOT-OCR2.0 and MinerU2.0
- Uses up to 60× fewer tokens than traditional approaches
- Can process 200K+ pages/day on a single A100

## Use Cases

- Long-context document processing
- Reducing token costs for long-form content
- Visual text representation for efficient LLM processing
- High-throughput document digitization

## Notes

This represents a shift in how long-context inefficiency might be solved—models might soon "see" text instead of reading it token-by-token, with optical compression potentially replacing textual compression methods.
