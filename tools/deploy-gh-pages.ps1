# 部署到 GitHub Pages
#
# 用法（PowerShell，在项目根目录）：
#   .\tools\deploy-gh-pages.ps1
#
# 做的事情：
#   1. 生产构建到 dist/
#   2. 在独立的临时目录初始化一个**干净**仓库（不继承主仓库的 LFS filter）
#   3. 把 dist/ 内容作为普通文件提交到 gh-pages 分支并强制推送
#
# 为什么要独立仓库而不是 `git subtree push`：
# Pages 不提供 LFS 服务。如果沿用主仓库的 .gitattributes，
# *.glb / *.ply / *.splat 会被转成 LFS 指针文件，Pages 上就返回
# "version https://git-lfs.github.com/spec/v1" 这样的文本，模型全部加载失败。
# 独立目录 + 关掉 LFS，才能保证二进制真实入库。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$githubRepo = 'https://github.com/WJJ-Stack/smart-workshop-dt.git'
$work = Join-Path $env:TEMP 'swdt-gh-pages'

Write-Host "[1/5] 构建生产产物…" -ForegroundColor Cyan
Push-Location $root
try {
    npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'typecheck 失败' }

    npx vite build
    if ($LASTEXITCODE -ne 0) { throw 'vite build 失败' }
}
finally {
    Pop-Location
}

$dist = Join-Path $root 'dist'
if (-not (Test-Path $dist)) { throw "找不到构建产物：$dist" }

Write-Host "[2/5] 准备发布目录…" -ForegroundColor Cyan
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null

Copy-Item (Join-Path $dist '*') $work -Recurse -Force

# 关键：本仓库不启用 LFS，且显式取消任何继承来的 filter
Write-Host "[3/5] 关闭 LFS（Pages 不支持 LFS）…" -ForegroundColor Cyan
Push-Location $work
try {
    git init -q -b gh-pages
    # 干净仓库默认没有 LFS filter，只需确保全局配置不影响（见下方 .gitattributes）。
    # 注意：不要在这里跑 `git lfs uninstall --local` —— 全新仓库没有 hooks 目录，
    # 该命令会因找不到 pre-push 而报错退出。
    git config --local lfs.fetchexclude '*'
    # 覆盖可能的全局 .gitattributes 影响
    Set-Content -Path '.gitattributes' -Encoding ascii -Value @'
# 本分支用于 GitHub Pages 发布。
# Pages 不提供 LFS，必须让二进制以真实内容入库。
*.glb    -filter -text -diff
*.gltf   -filter -text -diff
*.ply    -filter -text -diff
*.splat  -filter -text -diff
*.bin    -filter -text -diff
*.wasm   -filter -text -diff
'@

    # 防止 Jekyll 处理（不是必须，但避免 .nojekyll 缺失导致的路径问题）
    New-Item -ItemType File -Name '.nojekyll' -Force | Out-Null

    Write-Host "[4/5] 提交…" -ForegroundColor Cyan
    git add -A
    git -c user.name="WJJ-Stack" -c user.email="2643316236@qq.com" `
        commit -q -m "deploy: GitHub Pages build $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

    # 校验：确认没有任何 LFS 指针混进来
    $pointers = git grep -l 'git-lfs.github.com/spec' -- . 2>$null
    if ($pointers) {
        throw "仍有 LFS 指针文件，部署会 404：`n$($pointers -join "`n")"
    }
    Write-Host "    ✓ 无 LFS 指针" -ForegroundColor Green

    Write-Host "[5/5] 推送到 gh-pages…" -ForegroundColor Cyan
    git remote add origin $githubRepo
    git push -f origin gh-pages
    if ($LASTEXITCODE -ne 0) { throw '推送失败' }
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host '部署完成，稍等 1~2 分钟让 Pages 生效：' -ForegroundColor Green
Write-Host '  https://wjj-stack.github.io/smart-workshop-dt/' -ForegroundColor Yellow
Write-Host '  https://wjj-stack.github.io/smart-workshop-dt/assets.html' -ForegroundColor Yellow
