#!/bin/bash

echo "=== 开始执行 dev → test 合并流程（已优化自动提交 + 确保 push） ==="

# 当前分支检查
current_branch=$(git branch --show-current)
if [ "$current_branch" != "dev" ]; then
  echo "⚠️  当前分支是 $current_branch（不是 dev）"
  read -p "是否继续？(y/n): " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
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
    echo "❌ git pull 失败，请手动处理后按 Enter 重试..."
    read
  fi
done

# ====================== 步骤 2：dev 分支检查并提交 ======================
echo "步骤 2：检查 dev 分支状态..."
while [ -n "$(git status --porcelain)" ]; do
  echo "检测到未提交更改："
  git status
  echo "请选择："
  echo "  1) 输入提交消息，自动提交"
  echo "  2) 我手动处理，完成后继续"
  read -p "请输入 1 或 2: " choice
  if [ "$choice" = "1" ]; then
    read -p "请输入提交消息: " msg
    if [ -n "$msg" ]; then
      git add -A
      if git commit -m "$msg"; then
        echo "✅ 自动提交成功，继续下一步"
      else
        echo "❌ 提交失败（可能是无更改或冲突），请检查后重试"
      fi
    else
      echo "❌ 消息不能为空，请重试"
    fi
  else
    echo "请手动提交所有更改，完成后按 Enter 继续..."
    read
  fi
done
echo "✅ dev 分支已干净"

# ====================== 步骤 3：切换到 test ======================
echo "步骤 3：切换到 test 分支..."
while true; do
  git checkout test
  if [ $? -eq 0 ]; then
    echo "✅ 已切换到 test 分支"
    break
  else
    echo "❌ 切换失败，请手动处理后按 Enter 重试..."
    read
  fi
done

# ====================== 步骤 4：test 分支 git pull + 检查 ======================
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

# test pull 后再次确保干净
while [ -n "$(git status --porcelain)" ]; do
  echo "test 分支仍有未提交更改："
  git status
  echo "请选择：1) 自动提交  2) 手动处理"
  read -p "请输入 1 或 2: " choice
  if [ "$choice" = "1" ]; then
    read -p "请输入提交消息: " msg
    if [ -n "$msg" ]; then
      git add -A
      if git commit -m "$msg"; then
        echo "✅ 自动提交成功，继续下一步"
      else
        echo "❌ 提交失败，请检查"
      fi
    else
      echo "❌ 消息不能为空，请重试"
    fi
  else
    echo "请手动处理后按 Enter..."
    read
  fi
done

# ====================== 步骤 5：合并 dev ======================
echo "步骤 5：执行 git merge dev..."
git merge dev

# 处理可能的冲突
while [ -n "$(git status --porcelain)" ]; do
  echo "⚠️  合并存在冲突或未完成状态："
  git status
  echo "请先解决冲突（编辑文件 → git add），然后选择："
  echo "  1) 已解决，自动提交合并"
  echo "  2) 我手动完成，完成后继续"
  read -p "请输入 1 或 2: " choice
  if [ "$choice" = "1" ]; then
    read -p "请输入合并提交消息: " msg
    if [ -n "$msg" ]; then
      git add -A
      if git commit -m "$msg"; then
        echo "✅ 合并提交成功！"
      else
        echo "❌ 提交失败（请确认已解决所有冲突），请检查"
      fi
    else
      echo "❌ 消息不能为空，请重试"
    fi
  else
    echo "请处理好后按 Enter 继续检查..."
    read
  fi
done
echo "✅ merge dev 成功完成"

# ====================== 步骤 6：git push（保证一定会执行） ======================
echo "步骤 6：执行 git push 到远程 test 分支..."
while true; do
  git push
  if [ $? -eq 0 ]; then
    echo "✅ push 成功！"
    break
  else
    echo "❌ git push 失败，请手动处理后按 Enter 重试..."
    read
  fi
done

echo "=== 🎉 全部完成！dev 已成功合并并推送到 test 分支 ==="
echo "当前分支仍在 test，如需切回 dev 请执行：git checkout dev"