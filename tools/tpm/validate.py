#!/usr/bin/env python3
"""Validate an explicitly selected Markdown context store.

Checks every store page:
  - front matter with `id`, `type`, `status`;
  - unique `id` across pages;
  - relative Markdown links resolve to a file;
  - no secret-like strings (keys, tokens, passwords, long digit runs).

Usage: python3 validate.py --root STORE   (exit 1 on any finding)
"""
import argparse
import re
import sys
from pathlib import Path

STORE = ["charter.md", "README.md", "register.md", "commitments.md",
         "areas", "projects", "journal", "lab", "views", "procedures", "threads"]
REQUIRED = ("id", "type", "status")
LINK = re.compile(r"\]\(([^)#\s]+)(?:#[^)]*)?\)")
SECRETS = {
    "api key": re.compile(r"\b(?:ak|sk|pk|rk)[-_][A-Za-z0-9_-]{16,}"),
    "github token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    "aws key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "slack token": re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}"),
    "password field": re.compile(r"(?i)\b(?:password|passwd|密码|pwd)\s*[:=：]\s*\S+"),
    "long digit run (order, account, or ID number)": re.compile(r"(?<![\w.-])\d{9,}(?![\w-])"),
}


def pages(root):
    for entry in STORE:
        path = root / entry
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from sorted(path.rglob("*.md"))


def front_matter(text):
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    fields = {}
    for line in text[4:end].splitlines():
        key, sep, value = line.partition(":")
        if sep and not line.startswith(" "):
            fields[key.strip()] = value.strip()
    return fields


def validate(root):
    root = Path(root).resolve()
    if not root.is_dir():
        print('store root must be an existing directory', file=sys.stderr)
        return 1
    findings, ids = [], {}
    count = 0
    for path in pages(root):
        count += 1
        rel = path.relative_to(root)
        text = path.read_text(encoding="utf-8")
        meta = front_matter(text)
        if meta is None:
            findings.append(f"{rel}: missing front matter")
        else:
            for key in REQUIRED:
                if not meta.get(key):
                    findings.append(f"{rel}: missing `{key}`")
            if meta.get("id"):
                if meta["id"] in ids:
                    findings.append(f"{rel}: duplicate id `{meta['id']}` (also {ids[meta['id']]})")
                ids[meta["id"]] = rel
        for target in LINK.findall(text):
            if re.match(r"[a-z]+:", target):
                continue
            if not (path.parent / target).resolve().exists():
                findings.append(f"{rel}: broken link `{target}`")
        for lineno, line in enumerate(text.splitlines(), 1):
            for kind, pattern in SECRETS.items():
                if pattern.search(line):
                    findings.append(f"{rel}:{lineno}: possible secret ({kind})")
    if not count:
        findings.append('no store pages found')
    for finding in findings:
        print(finding)
    print(f"checked {count} pages, {len(findings)} findings")
    return 1 if findings else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    return validate(parser.parse_args().root)


if __name__ == "__main__":
    sys.exit(main())
