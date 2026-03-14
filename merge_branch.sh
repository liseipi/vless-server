#!/bin/bash

echo "=== 动态分支合并脚本：任意源分支 → 任意目标分支（成功后自动切回源分支） ==="

# ====================== 步骤 0：让用户输入分支名称 ======================
read -p "请输入源分支名称（当前开发分支，例如 dev）: " SOURCE_BRANCH
read -p "请输入目标分支名称（要合并到的分支，例如 test）: " TARGET_BRANCH

if [ -z "$SOURCE_BRANCH" ] || [ -z "$TARGET_BRANCH" ]; then
  echo "❌ 分支名称不能为空！脚本退出。"
  exit 1
fi
if [ "$SOURCE_BRANCH" = "$TARGET_BRANCH" ]; then
  echo "❌ 源分支和目标分支不能相同！脚本退出。"
  exit 1
fi

echo "✅ 已确认：将从 **$SOURCE_BRANCH** 合并到 **$TARGET_BRANCH**，完成后自动切回 $SOURCE_BRANCH"

# 当前分支检查
current_branch=$(git branch --show-current)
if [ "$current_branch" != "$SOURCE_BRANCH" ]; then
  echo "⚠️  当前分支是 $current_branch（不是 $SOURCE_BRANCH）"
  read -p "是否继续？(y/n): " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "脚本退出。"
    exit 1
  fi
fi

# ====================== 步骤 1：在源分支 git pull ======================
echo "步骤 1：在 $SOURCE_BRANCH 分支执行 git pull..."
while true; do
  git pull
  if [ $? -eq 0 ]; then
    echo "✅ $SOURCE_BRANCH pull 成功"
    break
  else
    echo "❌ git pull 失败，请手动处理后按 Enter 重试..."
    read
  fi
done

# ====================== 步骤 2：源分支检查并提交 ======================
echo "步骤 2：检查 $SOURCE_BRANCH 分支状态..."
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
        echo "❌ 提交失败，请检查"
      fi
    else
      echo "❌ 消息不能为空，请重试"
    fi
  else
    echo "请手动提交所有更改，完成后按 Enter 继续..."
    read
  fi
done
echo "✅ $SOURCE_BRANCH 分支已干净"

# ====================== 步骤 3：切换到目标分支 ======================
echo "步骤 3：切换到 $TARGET_BRANCH 分支..."
while true; do
  git checkout "$TARGET_BRANCH"
  if [ $? -eq 0 ]; then
    echo "✅ 已切换到 $TARGET_BRANCH 分支"
    break
  else
    echo "❌ 切换失败，请手动处理后按 Enter 重试..."
    read
  fi
done

# ====================== 步骤 4：目标分支 git pull ======================
echo "步骤 4：在 $TARGET_BRANCH 分支执行 git pull..."
while true; do
  git pull
  if [ $? -eq 0 ]; then
    echo "✅ $TARGET_BRANCH pull 成功"
    break
  else
    echo "❌ git pull 失败，请手动处理后按 Enter 重试..."
    read
  fi
done

# 确保目标分支干净
while [ -n "$(git status --porcelain)" ]; do
  echo "$TARGET_BRANCH 分支仍有未提交更改："
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

# ====================== 步骤 5：合并源分支 ======================
echo "步骤 5：执行 git merge $SOURCE_BRANCH..."
git merge "$SOURCE_BRANCH"

while [ -n "$(git status --porcelain)" ]; do
  echo "⚠️  合并存在冲突或未完成状态："
  git status
  echo "请先解决冲突，然后选择："
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
        echo "❌ 提交失败，请检查"
      fi
    else
      echo "❌ 消息不能为空，请重试"
    fi
  else
    echo "请处理好后按 Enter 继续检查..."
    read
  fi
done
echo "✅ merge $SOURCE_BRANCH 成功完成"

# ====================== 步骤 6：git push ======================
echo "步骤 6：执行 git push 到 $TARGET_BRANCH 分支..."
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

# ====================== 步骤 7：成功后自动切换回源分支 ======================
echo "步骤 7：全部成功！自动切换回开发分支 $SOURCE_BRANCH..."
git checkout "$SOURCE_BRANCH"
if [ $? -eq 0 ]; then
  echo "✅ 已自动切换回 $SOURCE_BRANCH 分支"
else
  echo "⚠️ 切换回 $SOURCE_BRANCH 失败（极少见），请手动执行：git checkout $SOURCE_BRANCH"
fi

echo "=== 🎉 全部流程完成！$SOURCE_BRANCH 已成功合并并推送到 $TARGET_BRANCH，并已切回 $SOURCE_BRANCH ==="