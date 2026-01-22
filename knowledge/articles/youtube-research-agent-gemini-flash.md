---
title: "YouTube Research Agent with Gemini Flash 2.0"
date: "Saturday, February 8, 2025"
tags: [[AI]] [[Agents]] [[Gemini]] [[YouTube]] [[Tutorial]]
source: "@llama_index"
source_url: "https://colab.research.google.com/drive/1Gw50AADkX7IxyI_64K0_qgNmBpLpXgVj"
---

**Tutorial:** https://colab.research.google.com/drive/1Gw50AADkX7IxyI_64K0_qgNmBpLpXgVj

## Overview

Step-by-step tutorial for building an autonomous YouTube research agent using Gemini Flash 2.0 as the reasoning backbone.

## Stack

- **LLM:** Gemini Flash 2.0
- **Framework:** LangChain
- **Tools:** ComposioHQ (YouTube search, video details, Gmail draft)
- **Notebook:** Google Colab

## Key Features

1. Search YouTube for recent popular videos matching a specified topic
2. Summarize video content
3. Draft or send email with research summary

## Architecture

```
Composio Tools → LangChain Function Calling Agent → Gemini Flash 2.0 → Research Summary
```

## Why Gemini Flash 2.0

- One of the cheapest reasoning models available
- Fast inference for agentic workflows
- Strong function calling capabilities
- Cost-effective for production deployments

## Source

Bookmark: [@llama_index - Building a YouTube Research Agent with Gemini Flash 2.0](https://x.com/llama_index/status/1888398838974844984)
