---
title: FlashMLA
slug: flashmla
description: DeepSeek's efficient Multi-head Latent Attention Kernels for NVIDIA Hopper GPUs
url: https://github.com/deepseek-ai/FlashMLA
category: ai
subcategory: gpu-optimization
tags:
  - ai
  - deepseek
  - gpu
  - attention-mechanism
  - nvidia
  - kernel-optimization
lastUpdated: "Sunday, February 23, 2025"
bookmarkDate: "Sunday, February 23, 2025"
sourceTweet: https://x.com/deepseek_ai/status/1893836827574030466
---

# FlashMLA

> Efficient Multi-head Latent Attention Kernels for Hopper GPUs

## Overview

FlashMLA is DeepSeek's library of optimized attention kernels for NVIDIA Hopper GPUs, specifically optimized for variable-length sequences. It powers the DeepSeek-V3 and DeepSeek-V3.2-Exp models and is now in production use.

## Key Features

- **BF16 support** for mixed precision inference
- **Paged KV cache** with block size 64 for efficient memory management
- **3000 GB/s memory-bound** throughput on NVIDIA H800
- **580 TFLOPS compute-bound** performance on H800
- Optimized for variable-length sequences

## Components

### Sparse Attention Kernels

These kernels power DeepSeek Sparse Attention (DSA):
- Token-level sparse attention for the prefill stage
- Token-level sparse attention for the decoding stage, with FP8 KV cache

### Dense Attention Kernels

- Dense attention for the prefill stage
- Dense attention for the decoding stage

## Performance Highlights

- Up to 640 TFlops during prefilling (sparse attention)
- Up to 410 TFlops during decoding (sparse attention)
- 5-15% performance improvement in latest releases
- Up to 660 TFlops on NVIDIA H800 SXM5 GPUs

## Use Cases

- High-performance AI inference
- LLM serving optimization
- GPU-accelerated transformer workloads
- Efficient attention computation at scale

## Resources

- [GitHub Repository](https://github.com/deepseek-ai/FlashMLA)
- [Technical Deep-Dive Blog](docs/20250422-new-kernel-deep-dive.md)
- [FP8 Sparse Decoding Deep-Dive](docs/20250929-hopper-fp8-sparse-deep-dive.md)

## Related

- [[deepseek-v3]] - DeepSeek-V3 model
- [[attention-mechanisms]] - Attention mechanism techniques
- [[gpu-optimization]] - GPU optimization strategies
