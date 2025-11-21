@echo off
REM Скрипт для построения и установки VS Code расширения
REM Build and Install VS Code Extension Script

REM Установка кодовой страницы UTF-8 для корректного отображения русских символов
chcp 65001 >nul 2>&1

setlocal enabledelayedexpansion

set SKIP_INSTALL=0
set VSIX_FILENAME=

REM Парсинг аргументов
:parse_args
if "%~1"=="" goto :end_parse
if /i "%~1"=="-SkipInstall" (
    set SKIP_INSTALL=1
    shift
    goto :parse_args
)
if /i "%~1"=="-VsixFileName" (
    set VSIX_FILENAME=%~2
    shift
    shift
    goto :parse_args
)
shift
goto :parse_args

:end_parse

echo ========================================
echo VS Code Extension Build and Install
echo ========================================
echo.

REM Проверка наличия Node.js
echo [1/5] Проверка Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   ОШИБКА: Node.js не найден. Установите Node.js и повторите попытку.
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo   Node.js найден: !NODE_VERSION!

REM Проверка наличия npm
echo [2/5] Проверка npm...
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   ОШИБКА: npm не найден. Установите npm и повторите попытку.
    exit /b 1
)
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo   npm найден: !NPM_VERSION!

REM Установка зависимостей
echo [3/5] Установка зависимостей...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo   ОШИБКА: Не удалось установить зависимости.
    exit /b 1
)
echo   Зависимости установлены успешно.

REM Компиляция TypeScript
echo [4/5] Компиляция TypeScript...
call npm run compile
if %ERRORLEVEL% NEQ 0 (
    echo   ОШИБКА: Компиляция не удалась.
    exit /b 1
)
echo   Компиляция завершена успешно.

REM Проверка наличия vsce
echo [5/5] Проверка vsce (VS Code Extension Manager)...
set VSCE_AVAILABLE=0
where vsce >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   vsce найден глобально.
    set VSCE_AVAILABLE=1
) else (
    echo   vsce не найден глобально. Проверка через npx...
    npx --yes vsce --version >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo   vsce доступен через npx.
        set VSCE_AVAILABLE=1
    ) else (
        echo   vsce не найден. Установка vsce...
        call npm install -g @vscode/vsce
        REM Проверяем, доступен ли vsce после установки
        npx --yes vsce --version >nul 2>&1
        if %ERRORLEVEL% EQU 0 (
            echo   vsce установлен успешно.
            set VSCE_AVAILABLE=1
        ) else (
            echo   ОШИБКА: Не удалось установить vsce.
            exit /b 1
        )
    )
)

if !VSCE_AVAILABLE! EQU 0 (
    echo   ОШИБКА: vsce недоступен.
    exit /b 1
)

REM Упаковка расширения
echo.
echo Упаковка расширения в .vsix файл...
if "!VSIX_FILENAME!"=="" (
    REM Генерируем имя файла на основе версии из package.json
    REM Используем node для надежного извлечения версии
    for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v
    set VSIX_FILENAME=vscode-map-preview-!VERSION!.vsix
)
echo   Создание файла: !VSIX_FILENAME!
call npx --yes vsce package -o !VSIX_FILENAME!
if errorlevel 1 (
    echo   ОШИБКА: Не удалось упаковать расширение.
    exit /b 1
)
if exist "!VSIX_FILENAME!" (
    echo   Расширение упаковано: !VSIX_FILENAME!
    for %%F in ("!VSIX_FILENAME!") do echo   Размер файла: %%~zF байт
) else (
    echo   ПРЕДУПРЕЖДЕНИЕ: Файл !VSIX_FILENAME! не найден после упаковки.
    echo   Проверьте вывод команды vsce package выше.
    exit /b 1
)

REM Установка расширения
if %SKIP_INSTALL% EQU 0 (
    echo.
    echo Установка расширения в VS Code...
    
    REM Проверка наличия команды code
    where code >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        code --install-extension !VSIX_FILENAME! --force
        if %ERRORLEVEL% EQU 0 (
            echo   Расширение установлено успешно!
            echo.
            echo   Перезапустите VS Code, чтобы активировать расширение.
        ) else (
            echo   ОШИБКА: Не удалось установить расширение.
            echo   Попробуйте установить вручную: code --install-extension !VSIX_FILENAME!
        )
    ) else (
        echo   ПРЕДУПРЕЖДЕНИЕ: Команда 'code' не найдена в PATH.
        echo   Установите расширение вручную через VS Code:
        echo   1. Откройте VS Code
        echo   2. Перейдите в Extensions (Ctrl+Shift+X)
        echo   3. Нажмите '...' -^> 'Install from VSIX...'
        echo   4. Выберите файл: !VSIX_FILENAME!
    )
) else (
    echo.
    echo Установка пропущена (используйте без -SkipInstall для установки).
    echo Для установки выполните: code --install-extension !VSIX_FILENAME!
)

echo.
echo ========================================
echo Готово!
echo ========================================
echo.

REM Пауза на 3 секунды перед закрытием окна
timeout /t 3 /nobreak >nul 2>&1

endlocal

