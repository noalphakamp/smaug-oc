#!/bin/bash
node -e "console.log(require('./.state/pending-bookmarks.json').count)"
