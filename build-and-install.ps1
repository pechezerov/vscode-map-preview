# Скрипт для построения и установки VS Code расширения
# Build and Install VS Code Extension Script

param(
    [switch]$SkipInstall = $false,
    [string]$VsixFileName = ""
)

# Установка кодировки UTF-8 для корректного отображения русских символов
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "VS Code Extension Build and Install" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Проверка наличия Node.js
Write-Host "[1/5] Проверка Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "  Node.js найден: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ОШИБКА: Node.js не найден. Установите Node.js и повторите попытку." -ForegroundColor Red
    exit 1
}

# Проверка наличия npm
Write-Host "[2/5] Проверка npm..." -ForegroundColor Yellow
try {
    $npmVersion = npm --version
    Write-Host "  npm найден: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "  ОШИБКА: npm не найден. Установите npm и повторите попытку." -ForegroundColor Red
    exit 1
}

# Установка зависимостей
Write-Host "[3/5] Установка зависимостей..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ОШИБКА: Не удалось установить зависимости." -ForegroundColor Red
    exit 1
}
Write-Host "  Зависимости установлены успешно." -ForegroundColor Green

# Компиляция TypeScript
Write-Host "[4/5] Компиляция TypeScript..." -ForegroundColor Yellow
npm run compile
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ОШИБКА: Компиляция не удалась." -ForegroundColor Red
    exit 1
}
Write-Host "  Компиляция завершена успешно." -ForegroundColor Green

# Проверка наличия vsce
Write-Host "[5/5] Проверка vsce (VS Code Extension Manager)..." -ForegroundColor Yellow
$vsceInstalled = $false
try {
    $vsceVersion = npx vsce --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        $vsceInstalled = $true
        Write-Host "  vsce найден." -ForegroundColor Green
    }
} catch {
    # vsce не найден, попробуем установить
}

if (-not $vsceInstalled) {
    Write-Host "  vsce не найден. Установка vsce..." -ForegroundColor Yellow
    npm install -g @vscode/vsce
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ОШИБКА: Не удалось установить vsce." -ForegroundColor Red
        exit 1
    }
    Write-Host "  vsce установлен успешно." -ForegroundColor Green
}

# Упаковка расширения
Write-Host ""
Write-Host "Упаковка расширения в .vsix файл..." -ForegroundColor Yellow
if ($VsixFileName -ne "") {
    npx vsce package -o $VsixFileName
} else {
    # Генерируем имя файла на основе версии из package.json
    $packageJson = Get-Content package.json | ConvertFrom-Json
    $version = $packageJson.version
    $VsixFileName = "vscode-map-preview-$version.vsix"
    npx vsce package -o $VsixFileName
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "  ОШИБКА: Не удалось упаковать расширение." -ForegroundColor Red
    exit 1
}
Write-Host "  Расширение упаковано: $VsixFileName" -ForegroundColor Green

# Установка расширения
if (-not $SkipInstall) {
    Write-Host ""
    Write-Host "Установка расширения в VS Code..." -ForegroundColor Yellow
    
    # Проверка наличия команды code
    try {
        $codeVersion = code --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            code --install-extension $VsixFileName --force
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  Расширение установлено успешно!" -ForegroundColor Green
                Write-Host ""
                Write-Host "  Перезапустите VS Code, чтобы активировать расширение." -ForegroundColor Cyan
            } else {
                Write-Host "  ОШИБКА: Не удалось установить расширение." -ForegroundColor Red
                Write-Host "  Попробуйте установить вручную: code --install-extension $VsixFileName" -ForegroundColor Yellow
            }
        } else {
            Write-Host "  ПРЕДУПРЕЖДЕНИЕ: Команда 'code' не найдена в PATH." -ForegroundColor Yellow
            Write-Host "  Установите расширение вручную через VS Code:" -ForegroundColor Yellow
            Write-Host "  1. Откройте VS Code" -ForegroundColor Yellow
            Write-Host "  2. Перейдите в Extensions (Ctrl+Shift+X)" -ForegroundColor Yellow
            Write-Host "  3. Нажмите '...' -> 'Install from VSIX...'" -ForegroundColor Yellow
            Write-Host "  4. Выберите файл: $VsixFileName" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  ПРЕДУПРЕЖДЕНИЕ: Команда 'code' не найдена в PATH." -ForegroundColor Yellow
        Write-Host "  Установите расширение вручную через VS Code:" -ForegroundColor Yellow
        Write-Host "  1. Откройте VS Code" -ForegroundColor Yellow
        Write-Host "  2. Перейдите в Extensions (Ctrl+Shift+X)" -ForegroundColor Yellow
        Write-Host "  3. Нажмите '...' -> 'Install from VSIX...'" -ForegroundColor Yellow
        Write-Host "  4. Выберите файл: $VsixFileName" -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "Установка пропущена (используйте без -SkipInstall для установки)." -ForegroundColor Yellow
    Write-Host "Для установки выполните: code --install-extension $VsixFileName" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Готово!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Пауза на 3 секунды перед закрытием окна
Start-Sleep -Seconds 3

