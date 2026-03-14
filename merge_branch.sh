#!/bin/bash

# =============================================
# Git 合并脚本：dev → test
# 使用说明：
# 1. 保存为 merge_dev_to_test.sh
# 2. chmod +x merge_dev_to_test.sh
# 3. ./merge_dev_to_test.sh
# 脚本会严格按你的要求一步步执行：
#   - 先 pull（失败会反复提示直到成功）
#   - 检查 status，有未提交文件会循环提示提交（支持自动或手动）
#   - 切换分支（失败会重试）
#   - test 分支 pull（同上）
#   - merge dev（冲突会自动进入处理循环）
#   - push（失败会重试直到成功）
# 每一步出问题都会清晰提示 + 等待你处理好后再继续下一步
# =============================================

echo "=== 开始执行 dev → test 合并流程 ==="

# 检查当前分支（友好提醒）
current_branch=$(git branch --show-current)
if [ "$current_branch" != "dev" ]; then
  echo "⚠️  当前分支是 $current_branch（不是 dev）"
  read -p "是否继续？(y/n): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "脚本退出。"
    exit 1
  fi
fi

# ====================== 步骤 1：dev 分支 git pull ======================
echo "步骤 1：在 dev 分支执行 git pull..."
while true; do
  git pull
  if [ $? -eq 0 ]; then
    echo "✅ dev pull 成功"
    break
  else
    echo "❌ git pull 失败（可能是网络问题、未提交更改或其他冲突）"
    echo "请手动处理后按 Enter 键重试 pull..."
    read
  fi
done

# ====================== 步骤 2：检查 git status 并提交 ======================
echo "步骤 2：检查当前分支状态，如果有需要提交的文件，会循环处理直到干净..."
while [ -n "$(git status --porcelain)" ]; do
  echo "检测到未提交的更改："
  git status
  echo "请选择操作："
  echo "  1) 输入提交消息，自动提交 (git add -A && commit)"
  echo "  2) 我手动处理 (git add / commit 等)，完成后继续"
  read -p "请输入 1 或 2: " choice
  if [ "$choice" = "1" ]; then
    read -p "请输入提交消息: " msg
    if [ -n "$msg" ]; then
      git add -A
      if git commit -m "$msg"; then
        echo "✅ 提交成功"
      else
        echo "提交失败，请检查"
      fi
    else
      echo "消息不能为空，请重试"
    fi
  else
    echo "请手动提交所有更改，完成后按 Enter 继续..."
    read
  fi
done
echo "✅ dev 分支已干净"

# ====================== 步骤 3：切换到 test 分支 ======================
echo "步骤 3：切换到 test 分支..."
while true; do
  git checkout test
  if [ $? -eq 0 ]; then
    echo "✅ 已切换到 test 分支"
    break
  else
    echo "❌ 切换失败（分支不存在或有其他问题）"
    echo "请手动处理后按 Enter 重试切换..."
    read
  fi
done

# ====================== 步骤 4：test 分支 git pull ======================
echo "步骤 4：在 test 分支执行 git pull..."
while true; do
  git pull
  if [ $? -eq 0 ]; then
    echo "✅ test pull 成功"
    break
  else
    echo "❌ git pull 失败，请手动处理后按 Enter 重试..."
    read
  fi
done

# ====================== 步骤 5：检查 test 状态并执行 merge ======================
# （pull 成功后再次确保干净，防止极少见情况）
while [ -n "$(git status --porcelain)" ]; do
  echo "test pull 后仍有未提交更改："
  git status
  echo "请选择：1) 自动提交  2) 手动处理"
  read -p "1 或 2: " choice
  if [ "$choice" = "1" ]; then
    read -p "提交消息: " msg
    git add -A && git commit -m "$msg"
  else
    read -p "手动处理后按 Enter..."
  fi
done

echo "步骤 5：执行 git merge dev..."
git merge dev
echo "检查合并结果..."
while [ -n "$(git status --porcelain)" ]; do
  echo "⚠️  合并存在冲突或未完成（Unmerged paths 或未提交文件）"
  git status
  echo "请解决冲突（编辑文件 → git add → git commit）"
  echo "请选择："
  echo "  1) 已解决，自动提交合并"
  echo "  2) 我手动完成，完成后继续"
  read -p "请输入 1 或 2: " choice
  if [ "$choice" = "1" ]; then
    read -p "请输入合并提交消息: " msg
    if [ -n "$msg" ]; then
      git add -A
      git commit -m "$msg"
    fi
  else
    echo "请处理好后按 Enter 继续检查..."
    read
  fi
done
echo "✅ merge dev 成功完成"

# ====================== 步骤 6：git push ======================
echo "步骤 6：执行 git push..."
while true; do
  git push
  if [ $? -eq 0 ]; then
    echo "✅ push 成功"
    break
  else
    echo "❌ git push 失败（可能是认证、远程拒绝等）"
    echo "请手动处理后按 Enter 重试 push..."
    read
  fi
done

echo "=== 🎉 所有步骤执行完毕！dev 已成功合并到 test 并推送 ==="
echo "当前分支仍在 test，如果你需要切回 dev，请手动 git checkout dev"