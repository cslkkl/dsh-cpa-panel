#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检测「调研报告归档」内所有 Markdown 文档的 .md 引用链接是否有效。
- 核心文档集/ 与 archive/ 为两棵引用目标树；根目录散件（蓝图等）也可作目标。
- 引用格式：反引号包裹的 `XX-名称.md`（含带路径前缀如 archive/XX.md）或纯文本 XX-名称.md。
用法: python 引用检测脚本.py
退出码: 0 = 无断裂引用，1 = 有断裂引用。
"""
import os
import re
import sys

# Windows 控制台默认 GBK，输出 ✓/✗ 会抛 UnicodeEncodeError；强制 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DATE_RE = re.compile(r"^\d{2,4}-\d{2}-\d{2}")  # 排除日期被误判为文件名引用

BASE = os.path.dirname(os.path.abspath(__file__))
TREES = {
    "root": BASE,                      # 根目录散件
    "core": os.path.join(BASE, "核心文档集"),
    "archive": os.path.join(BASE, "archive"),
}

# 收集每棵树里真实存在的文件名（不带路径，用于匹配）
existing = {k: set(os.listdir(v)) for k, v in TREES.items() if os.path.isdir(v)}

REF_RE = re.compile(r"`?([0-9]{2,3}-[^`\s》《，,。：;:、()（）]*?\.md)`?")
PATH_PREFIX_RE = re.compile(r"^(archive|核心文档集)/")

def resolve(target: str):
    """返回 (树名, 文件名) 或 None。"""
    m = PATH_PREFIX_RE.match(target)
    if m:
        tree = m.group(1)
        fname = target[m.end():]
        if tree in existing and fname in existing[tree]:
            return (tree, fname)
        return None
    # 无前缀：依次在 core / archive / root 找
    for tree in ("core", "archive", "root"):
        if target in existing[tree]:
            return (tree, target)
    return None

def scan_file(path):
    issues = []
    with open(path, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            for m in REF_RE.finditer(line):
                raw = m.group(0).strip("`")
                if raw.startswith(("http", "https", "#")):
                    continue
                if DATE_RE.match(raw):  # 日期（如 2026-10-03）不是文件引用
                    continue
                # 去掉可能的锚点（#xxx）
                target = raw.split("#")[0]
                if not resolve(target):
                    issues.append((ln, raw))
    return issues

def main():
    targets = []
    # 核心文档集
    for name in sorted(os.listdir(TREES["core"])):
        if name.endswith(".md"):
            targets.append(os.path.join(TREES["core"], name))
    # 根目录散件
    for name in sorted(os.listdir(BASE)):
        if name.endswith(".md"):
            targets.append(os.path.join(BASE, name))
    # archive（只统计，不纳入修复范围）
    archive_files = [n for n in os.listdir(TREES["archive"]) if n.endswith(".md")]

    print("=" * 70)
    print("引用检测报告  |  核心文档集 %d 份 + 根散件 %d 份 + archive %d 份" % (
        sum(1 for t in targets if os.path.dirname(t) == TREES["core"]),
        sum(1 for t in targets if os.path.dirname(t) == BASE),
        len(archive_files)))
    print("=" * 70)
    total = 0
    for path in targets:
        issues = scan_file(path)
        rel = os.path.relpath(path, BASE)
        if issues:
            total += len(issues)
            print(f"\n✗ {rel}  (断裂 {len(issues)} 处)")
            for ln, raw in issues:
                print(f"    L{ln}: `{raw}`")
        else:
            print(f"✓ {rel}")
    print("\n" + "=" * 70)
    print(f"总计断裂引用: {total} 处")
    return total

if __name__ == "__main__":
    sys.exit(main())
