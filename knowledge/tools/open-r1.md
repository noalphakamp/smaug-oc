---
title: "Open R1 - HuggingFace's Open Reproduction of DeepSeek-R1"
date: "Saturday, January 25, 2025"
tags: [[AI]] [[DeepSeek]] [[OpenSource]] [[Reasoning]]
source: "@QGallouedec"
source_url: "https://github.com/huggingface/open-r1"
---

**Repository:** https://github.com/huggingface/open-r1

## Overview

HuggingFace's open reproduction of DeepSeek-R1 training pipeline. A fully open project to replicate DeepSeek-R1's reasoning capabilities.

## Key Features

- **Open Data:** All training data will be openly available
- **Open Training:** Complete training scripts and pipeline
- **Open Models:** Reproducible model weights
- **Open Collaboration:** Community-driven development

## Technical Details

The repo is organized into three main steps:

1. **Step 1:** Replicate R1-Distill models by distilling from DeepSeek-R1
2. **Step 2:** Replicate pure RL pipeline (R1-Zero) with new curated datasets
3. **Step 3:** Demonstrate multi-stage training from base model to RL-tuned

### Project Structure

- `src/open_r1/` - Training scripts and data generation
  - `grpo.py` - GRPO training implementation
  - `sft.py` - Supervised fine-tuning
  - `generate.py` - Synthetic data generation
- `Makefile` - Easy-to-run commands for each pipeline step

## Evaluation

Reproducing DeepSeek's evaluation results to validate the pipeline.

## Significance

Represents "last moments of closed-source AI" according to maintainers, enabling anyone to build on top of DeepSeek-R1's breakthroughs.

## Related

- DeepSeek-R1: https://github.com/deepseek-ai/DeepSeek-R1
- Distilabel: https://github.com/argilla-io/distilabel
