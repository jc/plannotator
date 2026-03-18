---
title: "Code Review"
description: "The /plannotator-review slash command for reviewing uncommitted code changes or GitHub pull requests."
sidebar:
  order: 11
section: "Commands"
---

The `/plannotator-review` command opens an interactive code review UI for your uncommitted changes or a GitHub pull request.

## Usage

**Review uncommitted changes:**

```
/plannotator-review
```

**Review a GitHub pull request:**

```
/plannotator-review https://github.com/owner/repo/pull/123
```

PR review uses the `gh` CLI for authentication, so private repos work automatically if you're authenticated with `gh auth login`.

## How it works

**Local review:**

```
User runs /plannotator-review
        ↓
Agent runs: plannotator review
        ↓
git diff captures unstaged changes
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → feedback sent to agent
Approve → "LGTM" sent to agent
```

**PR review:**

```
User runs /plannotator-review <github-url>
        ↓
Agent runs: plannotator review <github-url>
        ↓
gh CLI fetches PR diff and metadata
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → PR context included in feedback
Approve → "LGTM" sent to agent
```

## The diff viewer

The review UI shows your changes in a familiar diff format:

- **File tree sidebar** — Navigate between changed files
- **Viewed tracking** — Mark files as viewed to track progress
- **Unified diff** — See additions and deletions in context
- **Annotation tools** — Same annotation types as plan review (delete, replace, comment, insert)

## Annotating code

Select any text in the diff to annotate it, just like in plan review. Your annotations are exported as structured feedback referencing specific lines and files.

## Submitting feedback

- **Send Feedback** — Formats your annotations and sends them to the agent
- **Approve** — Sends "LGTM" to the agent, indicating the changes look good

After submission, the agent receives your feedback and can act on it — fixing issues, explaining decisions, or making the requested changes.

## Server API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/diff` | GET | Returns `{ rawPatch, gitRef, origin }` |
| `/api/feedback` | POST | Submit review feedback |
| `/api/image` | GET | Serve image by path |
| `/api/upload` | POST | Upload image attachment |
