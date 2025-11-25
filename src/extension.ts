'use strict';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';

enum SourceType {
    SCRIPT,
    STYLE
}

const EPSG_REGEX = /^EPSG:\d+$/g;
const SCHEME = "map-preview";
const WEBVIEW_TYPE = "mapPreview";
const PREVIEW_COMMAND_ID = "map.preview";
const PREVIEW_PROJ_COMMAND_ID = "map.preview-with-proj";
const CLOSE_POLYGONS_COMMAND_ID = "map.close-polygons";
const SIMPLIFY_GEOMETRIES_COMMAND_ID = "map.simplify-geometries";

interface IWebViewContext {
    asWebviewUri(src: vscode.Uri): vscode.Uri;
    getCspSource(): string;
    getScriptNonce(): string;
    getStylesheetNonce(): string;
}

function makePreviewUri(doc: vscode.TextDocument): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://map-preview/map-preview: ${doc.fileName}`);
}

class PreviewDocumentContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    private _projections = new Map<string, string>();
    private _subscriptions: vscode.Disposable;

    constructor(private extensionPath: string) {
        this._subscriptions = vscode.Disposable.from(
            vscode.workspace.onDidOpenTextDocument(this.onDocumentOpened.bind(this))
        );
    }

    dispose() {
        this._projections.clear();
        this._subscriptions.dispose();
        this._onDidChange.dispose();
    }

    onDocumentOpened(e: vscode.TextDocument): void {
        //console.log(`Document opened ${e.uri}`);
        const uri = makePreviewUri(e);
        this._onDidChange.fire(uri);
    }

    public triggerVirtualDocumentChange(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }

    public clearPreviewProjection(uri: vscode.Uri): void {
        this._projections.delete(uri.toString());
    }

    public setPreviewProjection(uri: vscode.Uri, projection: string): void {
        this._projections.set(uri.toString(), projection);
    }

    private resolveDocument(uri: vscode.Uri): vscode.TextDocument {
        const matches = vscode.window.visibleTextEditors.filter(ed => {
            return makePreviewUri(ed.document).toString() == uri.toString();
        });
        if (matches.length >= 1) { //If we get more than one match, it's probably because the same document has been opened more than once (eg. split view)
            return matches[0].document;
        } else {
            return null;
        }
    }

    private generateDocumentContent(uri: vscode.Uri): string {
        const doc = this.resolveDocument(uri);
        if (doc) {
            let proj = null;
            const sUri = uri.toString();
            if (this._projections.has(sUri)) {
                proj = this._projections.get(sUri);
            }
            const content = this.createMapPreview(doc, proj);
            const debugSettings = vscode.workspace.getConfiguration("map.preview.debug");
            if (debugSettings.has("dumpContentPath")) {
                const dumpPath = debugSettings.get<string>("dumpContentPath");
                if (dumpPath) {
                    try {
                        fs.writeFileSync(dumpPath, content);
                    } catch (e) {
                        vscode.window.showErrorMessage(`Error dumping preview content: ${e.message}`);
                    }
                }
            }
            return content;
        } else {
            return this.errorSnippet(`<h1>Error preparing preview</h1><p>Cannot resolve document for virtual document URI: ${uri.toString()}</p>`);
        }
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const content = this.generateDocumentContent(uri);
        // Need to set up CSP for any URLs we find in the base layer defns
        const baseLayersRoot = vscode.workspace.getConfiguration("map.preview.customLayers");
        const cspAllowedUrls = [];
        if (baseLayersRoot.has("base")) {
            const baseLayers = baseLayersRoot.get("base");
            if (Array.isArray(baseLayers)) {
                for (const bldef of baseLayers) {
                    switch (bldef.kind) {
                        // xyz layers already handled by the https: img-src policy
                        case "wmts":
                            {
                                const url = bldef.sourceParams.find(sp => sp.name === 'wmts:capabilitiesUrl')?.value;
                                if (url) {
                                    cspAllowedUrls.push(url);
                                }
                            }
                            break;
                    }
                }
            }
        }

        return `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8">
        <!--
        Use a content security policy to only allow loading images from https or from our extension directory,
        and only allow scripts that have a specific nonce.
        -->
        <meta 
            http-equiv="Content-Security-Policy"
            content="default-src 'none';
                img-src ${this._wctx.getCspSource()} data: https:;
                worker-src ${this._wctx.getCspSource()} blob:;
                connect-src ${this._wctx.getCspSource()} https://dev.virtualearth.net ${cspAllowedUrls.join(" ")};
                script-src 'nonce-${this._wctx.getScriptNonce()}' 'unsafe-eval' ${this._wctx.getCspSource()};
                style-src 'unsafe-inline' ${this._wctx.getCspSource()};
                style-src-elem 'unsafe-inline' ${this._wctx.getCspSource()};" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Map Preview</title>
    </head>
    ${content}
</html>`;
    }

    private errorSnippet(error: string): string {
        return `
            <body>
                ${error}
            </body>`;
    }

    /**
     * Expose an event to signal changes of _virtual_ documents
     * to the editor
     */
    get onDidChange(): vscode.Event<vscode.Uri> {
        return this._onDidChange.event;
    }

    private _wctx: IWebViewContext | undefined;

    public attachWebViewContext(xformer: IWebViewContext) {
        this._wctx = xformer;
    }

    public detachWebViewContext() {
        this._wctx = undefined;
    }

    private createLocalSource(file: string, type: SourceType) {
        const onDiskPath = vscode.Uri.file(
            path.join(this.extensionPath, 'static', file)
        );
        const source_path = this._wctx.asWebviewUri(onDiskPath);
        switch (type) {
            case SourceType.SCRIPT:
                return `<script nonce="${this._wctx.getScriptNonce()}" src="${source_path}" type="text/javascript"></script>`;
            case SourceType.STYLE:
                return `<link nonce="${this._wctx.getStylesheetNonce()}" href="${source_path}" rel="stylesheet" />`;
        }
    }

    private createMapPreview(doc: vscode.TextDocument, projection: string = null) {
        const config = vscode.workspace.getConfiguration("map.preview");
        /*
        //We cannot proceed if default base layer is one that requires API keys and no API key has been provided
        const baseLayer = config.get<string>("defaultBaseLayer");
        switch (baseLayer) {
            case "stamen-toner":
            case "stamen-terrain":
            case "stamen-water":
                {
                    let hasApiKey = false;
                    if (config.has("apikeys.stadiamaps")) {
                        const key = config.get<string>("apikeys.stadiamaps") ?? "";
                        hasApiKey = (key.trim().length > 0);
                    }
                    if (!hasApiKey) {
                        return this.errorSnippet(`<h1>API Key Required</h1>
<p>Your chosen default base layer of <strong>${baseLayer}</strong> requires a Stadia Maps API key and no such key was provided</p>
<p>Please specify a valid API key for the <strong>map.preview.apikeys.stadiamaps</strong> setting, or change the <strong>map.preview.defaultBaseLayer</strong> setting to a layer type that does not require an API key (like <strong>osm</strong>)</p>`);
                    }
                }
        }
        */

        return `<body>
            <div id="map" style="width: 100%; height: 100%">
                <div id="format" style="position: absolute; left: 40; top: 5; z-index: 100; padding: 5px; background: yellow; color: black"></div>
                <div id="geometry-info" style="position: absolute; right: 10px; top: 200px; width: 210px; max-height: 80%; overflow-y: auto; z-index: 1000; background: rgba(255, 255, 255, 0.95); border: 1px solid #ccc; border-radius: 4px; padding: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.2); font-size: 12px;"></div>
            </div>
            <div id="loading-mask" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0">
                <div>Loading Preview ...</div>
            </div>` +
            this.createLocalSource("purify.min.js", SourceType.SCRIPT) +
            this.createLocalSource("ol.css", SourceType.STYLE) +
            this.createLocalSource("ol-layerswitcher.css", SourceType.STYLE) +
            this.createLocalSource("ol-popup.css", SourceType.STYLE) +
            this.createLocalSource("proj4.js", SourceType.SCRIPT) +
            this.createLocalSource("papaparse.min.js", SourceType.SCRIPT) +
            this.createLocalSource("ol.js", SourceType.SCRIPT) +
            this.createLocalSource("ol-layerswitcher.js", SourceType.SCRIPT) +
            this.createLocalSource("ol-popup.js", SourceType.SCRIPT) +
            this.createLocalSource("jsts.min.js", SourceType.SCRIPT) +
            `<script nonce="${this._wctx.getScriptNonce()}" type="text/javascript">
                // Инициализируем VS Code API в самом начале, до загрузки других скриптов
                window.vscode = acquireVsCodeApi();
            </script>` +
            this.createLocalSource("preview.js", SourceType.SCRIPT) +
            this.createLocalSource("preview.css", SourceType.STYLE) +
            `<script nonce="${this._wctx.getScriptNonce()}" type="text/javascript">

                function setError(e) {
                    var mapEl = document.getElementById("map");
                    var errHtml = "<h1>An error occurred rendering preview</h1>";
                    //errHtml += "<p>" + DOMPurify.sanitize(e.name) + ": " + DOMPurify.sanitize(e.message) + "</p>";
                    errHtml += "<pre>" + DOMPurify.sanitize(e.stack) + "</pre>";
                    mapEl.innerHTML = errHtml;
                }

                var currentMap = null;
                var currentPreviewConfig = null;
                var currentFormatOptions = null;
                var currentDocUri = "${this._wctx.asWebviewUri(doc.uri)}";
                var currentPreviewProj = ${projection ? ('"' + projection + '"') : "null"};

                function loadPreview() {
                    try {
                        var previewConfig = ${JSON.stringify(config)};
                        previewConfig.sourceProjection = currentPreviewProj;
                        currentPreviewConfig = previewConfig;
                        
                        var formatOptions = { featureProjection: 'EPSG:3857' };
                        if (currentPreviewProj != null) {
                            formatOptions.dataProjection = currentPreviewProj; 
                        }
                        currentFormatOptions = formatOptions;
                        
                        // Добавляем timestamp для предотвращения кэширования
                        var uriWithCacheBuster = currentDocUri + (currentDocUri.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
                        fetch(uriWithCacheBuster, { cache: 'no-cache' }).then(r => {
                            r.text().then(content => {
                                createPreviewSource(content, formatOptions, previewConfig, function (preview) {
                                    document.getElementById("format").innerHTML = "Format: " + preview.driver;
                                    
                                    // Обновляем информацию о геометриях после загрузки всех скриптов
                                    setTimeout(function() {
                                        if (typeof updateGeometryInfo === 'function') {
                                            updateGeometryInfo(preview.source);
                                        }
                                    }, 500);
                                    
                                    // Если карта уже существует, обновляем её
                                    if (window.currentMap) {
                                        currentMap = window.currentMap;
                                        // Находим слой предпросмотра
                                        var layers = currentMap.getLayers();
                                        var previewLayerGroup = null;
                                        for (var i = 0; i < layers.getLength(); i++) {
                                            var layer = layers.item(i);
                                            if (layer.get('title') === 'Map Preview') {
                                                previewLayerGroup = layer;
                                                break;
                                            }
                                        }
                                        
                                        if (previewLayerGroup) {
                                            var previewLayer = previewLayerGroup.getLayers().item(0);
                                            if (previewLayer) {
                                                // Получаем старый источник
                                                var oldSource = previewLayer.getSource();
                                                
                                                // Очищаем старые features из старого источника
                                                if (oldSource) {
                                                    oldSource.clear(true);
                                                }
                                                
                                                // Устанавливаем новый источник данных
                                                previewLayer.setSource(preview.source);
                                                
                                                // Функция для обновления карты после загрузки данных
                                                var updateMapExtent = function() {
                                                    try {
                                                        var features = preview.source.getFeatures();
                                                        if (features && features.length > 0) {
                                                            // Обновляем экстент карты
                                                            var view = currentMap.getView();
                                                            var extent = preview.source.getExtent();
                                                            if (extent && extent.length === 4 && 
                                                                !isNaN(extent[0]) && !isNaN(extent[1]) && 
                                                                !isNaN(extent[2]) && !isNaN(extent[3])) {
                                                                // Сохраняем текущий зум, если он был установлен пользователем
                                                                var currentZoom = view.getZoom();
                                                                view.fit(extent, {
                                                                    size: currentMap.getSize(),
                                                                    padding: [50, 50, 50, 50],
                                                                    duration: 500,
                                                                    maxZoom: currentZoom && currentZoom > 10 ? currentZoom : undefined
                                                                });
                                                            }
                                                        }
                                                        
                                                        // Принудительно обновляем карту
                                                        currentMap.updateSize();
                                                        currentMap.render();
                                                    } catch (e) {
                                                        console.error('Error updating map:', e);
                                                    }
                                                };
                                                
                                                // Проверяем, загружены ли features
                                                var checkAndUpdate = function() {
                                                    var features = preview.source.getFeatures();
                                                    if (features && features.length > 0) {
                                                        updateMapExtent();
                                                    } else {
                                                        // Ждем загрузки features
                                                        setTimeout(checkAndUpdate, 50);
                                                    }
                                                };
                                                
                                                // Начинаем проверку
                                                setTimeout(checkAndUpdate, 100);
                                                
                                                // Обновляем информацию о геометриях после обновления карты
                                                setTimeout(function() {
                                                    if (typeof updateGeometryInfo === 'function') {
                                                        updateGeometryInfo(preview.source);
                                                    }
                                                }, 200);
                                            }
                                        }
                                    } else {
                                        // Создаём новую карту
                                        initPreviewMap('map', preview, previewConfig);
                                        // Сохраняем ссылку на карту после инициализации
                                        setTimeout(function() {
                                            if (window.currentMap) {
                                                currentMap = window.currentMap;
                                            }
                                        }, 100);
                                    }
                                });
                            }).catch(e => setError(e));
                        }).catch(e => setError(e));                    
                    } catch (e) {
                        setError(e);
                    }
                }

                // VS Code API уже инициализирован в начале скрипта
                // Обработчик сообщений от расширения
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message && message.command) {
                        switch (message.command) {
                            case 'updatePreview':
                                // Обновляем предпросмотр
                                console.log('Received updatePreview command');
                                loadPreview();
                                break;
                            case 'simplifyGeometries':
                                // Упрощаем геометрии
                                console.log('Received simplifyGeometries command');
                                if (typeof simplifyGeoJSONGeometries === 'function' && typeof currentDocUri !== 'undefined') {
                                    const docUri = currentDocUri;
                                    fetch(docUri + (docUri.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now(), { cache: 'no-cache' })
                                        .then(r => {
                                            if (!r.ok) {
                                                throw new Error('HTTP error! status: ' + r.status);
                                            }
                                            return r.text();
                                        })
                                        .then(content => {
                                            // Упрощаем GeoJSON
                                            const simplified = simplifyGeoJSONGeometries(content);
                                            
                                            // Проверяем, были ли внесены изменения
                                            if (simplified === content) {
                                                window.vscode.postMessage({
                                                    command: 'info',
                                                    message: 'Геометрии уже упрощены или не требуют упрощения'
                                                });
                                            } else {
                                                // Отправляем упрощенный контент в расширение
                                                window.vscode.postMessage({
                                                    command: 'simplifyGeometries',
                                                    content: simplified
                                                });
                                            }
                                        })
                                        .catch(e => {
                                            console.error('Error:', e);
                                            window.vscode.postMessage({
                                                command: 'error',
                                                message: 'Ошибка при упрощении геометрий: ' + e.message
                                            });
                                        });
                                } else {
                                    window.vscode.postMessage({
                                        command: 'error',
                                        message: 'Функция упрощения геометрий недоступна'
                                    });
                                }
                                break;
                        }
                    }
                });

                // Уведомляем расширение, что webview готов
                window.vscode.postMessage({ command: 'ready' });

                // Загружаем предпросмотр при инициализации
                loadPreview();
            </script>
        </body>`;
    }
}

// Map для отслеживания открытых панелей предпросмотра: docUri -> panel
const previewPanels = new Map<string, vscode.WebviewPanel>();

function loadWebView(content: PreviewDocumentContentProvider, previewUri: vscode.Uri, fileName: string, extensionPath: string, doc: vscode.TextDocument, subscriptions: vscode.Disposable[]) {
    //const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    const docName = path.basename(fileName);
    const docDir = path.dirname(fileName);
    
    // Проверяем, есть ли уже открытая панель для этого документа
    const docUriString = doc.uri.toString();
    let panel = previewPanels.get(docUriString);
    
    if (panel) {
        // Если панель уже существует, просто показываем её
        panel.reveal(vscode.ViewColumn.Two);
    } else {
        // Создаём новую панель
        panel = vscode.window.createWebviewPanel(
            WEBVIEW_TYPE,
            `Map Preview: ${docName}`,
            vscode.ViewColumn.Two,
            {
                // Enable scripts in the webview
                enableScripts: true,
                // Restrict the webview to only loading content from our extension's `static` directory.
                localResourceRoots: [
                    vscode.Uri.file(path.join(extensionPath, 'static')),
                    // IMPORTANT: Otherwise our generated HTML cannot fetch() this document's content
                    vscode.Uri.file(docDir)
                ]
            }
        );
        
        // Удаляем панель из Map при закрытии
        panel.onDidDispose(() => {
            previewPanels.delete(docUriString);
        });
        
        previewPanels.set(docUriString, panel);
    }
    
    const scriptNonce = getNonce();
    const cssNonce = getNonce();
    const wctx: IWebViewContext = {
        asWebviewUri: uri => panel.webview.asWebviewUri(uri),
        getCspSource: () => panel.webview.cspSource,
        getScriptNonce: () => scriptNonce,
        getStylesheetNonce: () => cssNonce
    };
    content.attachWebViewContext(wctx);
    const html = content.provideTextDocumentContent(previewUri);
    content.detachWebViewContext();
    panel.webview.html = html;
    
    // Обработчик сообщений от webview
    panel.webview.onDidReceiveMessage(
        async message => {
            switch (message.command) {
                case 'ready':
                    // Webview готов, можно отправлять обновления
                    break;
                case 'normalizeGeometries':
                    // Получаем нормализованный контент от webview
                    const normalizedContent = message.content;
                    if (normalizedContent) {
                        try {
                            // Находим соответствующий документ
                            const docUriString = doc.uri.toString();
                            const textEditor = vscode.window.visibleTextEditors.find(ed => 
                                ed.document.uri.toString() === docUriString
                            );
                            
                            if (textEditor) {
                                // Обновляем документ
                                const edit = new vscode.WorkspaceEdit();
                                const fullRange = new vscode.Range(
                                    textEditor.document.positionAt(0),
                                    textEditor.document.positionAt(textEditor.document.getText().length)
                                );
                                edit.replace(textEditor.document.uri, fullRange, normalizedContent);
                                
                                const applied = await vscode.workspace.applyEdit(edit);
                                if (applied) {
                                    // Сохраняем документ
                                    await textEditor.document.save();
                                    vscode.window.showInformationMessage('Незамкнутые контуры успешно исправлены');
                                } else {
                                    vscode.window.showErrorMessage('Не удалось применить изменения');
                                }
                            } else {
                                vscode.window.showErrorMessage('Документ не найден в открытых редакторах');
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage('Ошибка при нормализации геометрий: ' + error.message);
                        }
                    }
                    break;
                case 'simplifyGeometries':
                    // Получаем упрощенный контент от webview
                    const simplifiedContent = message.content;
                    if (simplifiedContent) {
                        try {
                            // Находим соответствующий документ
                            const docUriString = doc.uri.toString();
                            const textEditor = vscode.window.visibleTextEditors.find(ed => 
                                ed.document.uri.toString() === docUriString
                            );
                            
                            if (textEditor) {
                                // Обновляем документ
                                const edit = new vscode.WorkspaceEdit();
                                const fullRange = new vscode.Range(
                                    textEditor.document.positionAt(0),
                                    textEditor.document.positionAt(textEditor.document.getText().length)
                                );
                                edit.replace(textEditor.document.uri, fullRange, simplifiedContent);
                                
                                const applied = await vscode.workspace.applyEdit(edit);
                                if (applied) {
                                    // Сохраняем документ
                                    await textEditor.document.save();
                                    vscode.window.showInformationMessage('Геометрии успешно упрощены');
                                } else {
                                    vscode.window.showErrorMessage('Не удалось применить изменения');
                                }
                            } else {
                                vscode.window.showErrorMessage('Документ не найден в открытых редакторах');
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage('Ошибка при упрощении геометрий: ' + error.message);
                        }
                    }
                    break;
                case 'error':
                    vscode.window.showErrorMessage(message.message || 'Произошла ошибка');
                    break;
                case 'info':
                    vscode.window.showInformationMessage(message.message || 'Информация');
                    break;
            }
        },
        undefined,
        subscriptions
    );
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

interface ProjectionItem extends vscode.QuickPickItem {
    projection: string;
}

interface NormalizeResult {
    geom: any;
    modified: boolean;
}

// Функция для нормализации незамкнутых контуров в GeoJSON
function normalizeGeoJSONGeometries(geoJSON: string): string {
    try {
        const parsed = JSON.parse(geoJSON);
        let modified = false;
        
        function closeRing(ring: number[][]): { ring: number[][]; modified: boolean } {
            // Создаем копию массива
            const ringCopy = ring.map(coord => [coord[0], coord[1]]);
            
            // Минимум 2 точки нужно для контура
            if (ringCopy.length < 2) {
                return { ring: ringCopy, modified: false }; // Недостаточно точек для контура
            }
            
            const first = ringCopy[0];
            const last = ringCopy[ringCopy.length - 1];
            
            // Проверяем, замкнут ли контур (с небольшой погрешностью для числовых ошибок)
            const tolerance = 1e-10;
            const isClosed = Math.abs(first[0] - last[0]) < tolerance && 
                           Math.abs(first[1] - last[1]) < tolerance;
            
            if (!isClosed) {
                // Добавляем первую точку в конец для замыкания контура
                ringCopy.push([first[0], first[1]]);
                return { ring: ringCopy, modified: true };
            }
            
            return { ring: ringCopy, modified: false };
        }
        
        function normalizeGeometry(geom: any): NormalizeResult {
            if (!geom) {
                return { geom: geom, modified: false };
            }
            
            // Если объект имеет geometry, но не имеет type (не Feature), обрабатываем geometry
            if (!geom.type && geom.geometry) {
                let localModified = false;
                let result = JSON.parse(JSON.stringify(geom)); // Глубокая копия
                const normalized = normalizeGeometry(result.geometry);
                result.geometry = normalized.geom;
                if (normalized.modified) {
                    localModified = true;
                }
                return { geom: result, modified: localModified };
            }
            
            // Если нет type, возвращаем без изменений
            if (!geom.type) {
                return { geom: geom, modified: false };
            }
            
            let localModified = false;
            let result = JSON.parse(JSON.stringify(geom)); // Глубокая копия
            
            switch (result.type) {
                case 'Polygon':
                    // Применяем изменения только к массивам coordinates внутри Polygon
                    if (result.coordinates && Array.isArray(result.coordinates)) {
                        const closedRings = result.coordinates.map((ring: number[][]) => {
                            const closed = closeRing(ring);
                            if (closed.modified) {
                                localModified = true;
                            }
                            return closed.ring;
                        });
                        result.coordinates = closedRings;
                    }
                    break;
                    
                case 'MultiPolygon':
                    // Применяем изменения только к массивам coordinates внутри MultiPolygon
                    if (result.coordinates && Array.isArray(result.coordinates)) {
                        const closedPolygons = result.coordinates.map((polygon: number[][][]) => {
                            return polygon.map((ring: number[][]) => {
                                const closed = closeRing(ring);
                                if (closed.modified) {
                                    localModified = true;
                                }
                                return closed.ring;
                            });
                        });
                        result.coordinates = closedPolygons;
                    }
                    break;
                    
                case 'Feature':
                    // Если это Feature, обрабатываем только его geometry (рекурсивно)
                    if (result.geometry) {
                        const normalized = normalizeGeometry(result.geometry);
                        result.geometry = normalized.geom;
                        if (normalized.modified) {
                            localModified = true;
                        }
                    }
                    break;
                    
                case 'FeatureCollection':
                    // Если это FeatureCollection, обрабатываем только features (рекурсивно)
                    if (result.features && Array.isArray(result.features)) {
                        result.features = result.features.map((feature: any) => {
                            const normalized = normalizeGeometry(feature);
                            if (normalized.modified) {
                                localModified = true;
                            }
                            return normalized.geom;
                        });
                    }
                    break;
                    
                default:
                    // Для всех остальных типов геометрий (Point, LineString, MultiPoint, MultiLineString и т.д.)
                    // возвращаем без изменений
                    return { geom: result, modified: false };
            }
            
            return { geom: result, modified: localModified };
        }
        
        // Обрабатываем разные типы входных данных
        let result: any;
        const isArray = Array.isArray(parsed);
        
        // Если это массив
        if (isArray && parsed.length > 0) {
            const firstItem = parsed[0];
            if (firstItem && typeof firstItem === 'object') {
                // Проверяем, является ли это массивом features (имеет свойство geometry)
                if (firstItem.geometry) {
                    // Обрабатываем каждый feature в массиве
                    result = parsed.map((item: any) => {
                        const normalized = normalizeGeometry(item);
                        if (normalized.modified) {
                            modified = true;
                        }
                        return normalized.geom;
                    });
                } 
                // Проверяем, является ли это массивом геометрий (имеет type)
                else if (firstItem.type) {
                    // Обрабатываем каждую геометрию в массиве
                    result = parsed.map((item: any) => {
                        const normalized = normalizeGeometry(item);
                        if (normalized.modified) {
                            modified = true;
                        }
                        return normalized.geom;
                    });
                } else {
                    // Неизвестный формат массива, возвращаем как есть
                    return geoJSON;
                }
            } else {
                // Не массив объектов, возвращаем как есть
                return geoJSON;
            }
        } else {
            // Обрабатываем как единый объект (Feature, FeatureCollection, Geometry)
            const normalized = normalizeGeometry(parsed);
            result = normalized.geom;
            if (normalized.modified) {
                modified = true;
            }
        }
        
        if (modified) {
            // Убеждаемся, что структура сохранилась (массив остался массивом, объект остался объектом)
            if (isArray && !Array.isArray(result)) {
                // Это не должно произойти, но на всякий случай возвращаем исходный файл
                console.error('Structure mismatch: input was array but result is not');
                return geoJSON;
            }
            if (!isArray && Array.isArray(result)) {
                // Это не должно произойти, но на всякий случай возвращаем исходный файл
                console.error('Structure mismatch: input was not array but result is array');
                return geoJSON;
            }
            // Дополнительная проверка: убеждаемся, что массив остался массивом
            const resultString = JSON.stringify(result, null, 2);
            const reparsed = JSON.parse(resultString);
            if (isArray && !Array.isArray(reparsed)) {
                console.error('Structure lost after stringify: input was array but reparsed is not');
                return geoJSON;
            }
            return resultString;
        }
        
        return geoJSON;
    } catch (e: any) {
        console.error('Error normalizing GeoJSON:', e);
        return geoJSON;
    }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    const extensionPath = context.extensionPath;
    const provider = new PreviewDocumentContentProvider(extensionPath);
    const registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
    const previewCommand = vscode.commands.registerCommand(PREVIEW_COMMAND_ID, () => {
        const editor = vscode.window.activeTextEditor;
        // Probable cause: File is too big. VSCode won't even hand us just the URI of the document (which is
        // what we really are after). Nothing we can do here.
        //
        // TODO: Of course if VSCode ever introduces an API that gives us the URI of the active document we may
        // be able to revisit this
        if (!editor) { 
            vscode.window.showErrorMessage("This file is too big to be previewed");
            return;
        }
        const doc = editor.document;
        const previewUri = makePreviewUri(doc);
        provider.clearPreviewProjection(previewUri);
        provider.triggerVirtualDocumentChange(previewUri);
        loadWebView(provider, previewUri, doc.fileName, extensionPath, doc, context.subscriptions);
    });

    const previewWithProjCommand = vscode.commands.registerCommand(PREVIEW_PROJ_COMMAND_ID, () => {
        const editor = vscode.window.activeTextEditor;
        // Probable cause: File is too big. VSCode won't even hand us just the URI of the document (which is
        // what we really are after). Nothing we can do here.
        //
        // TODO: Of course if VSCode ever introduces an API that gives us the URI of the active document we may
        // be able to revisit this
        if (!editor) {
            vscode.window.showErrorMessage("This file is too big to be previewed");
            return;
        }
        const opts: vscode.QuickPickOptions = {
            canPickMany: false,
            //prompt: "Enter the EPSG code for your projection",
            placeHolder: "EPSG:XXXX"
        };
        const config = vscode.workspace.getConfiguration("map.preview");
        const codes = [
            "EPSG:4326",
            "EPSG:3857",
            ...config.projections
                .filter(prj => prj.epsgCode != 4326 && prj.epsgCode != 3857)
                .map(prj => `EPSG:${prj.epsgCode}`)
        ].map((epsg: string) => ({
            label: `Preview in projection (${epsg})`,
            projection: epsg
        } as ProjectionItem));
        vscode.window.showQuickPick(codes, opts).then(val => {
            if (val) {
                const doc = editor.document;
                const previewUri = makePreviewUri(doc);
                provider.setPreviewProjection(previewUri, val.projection);
                provider.triggerVirtualDocumentChange(previewUri);
                loadWebView(provider, previewUri, doc.fileName, extensionPath, doc, context.subscriptions);
            }
        });
    });

    const closePolygonsCommand = vscode.commands.registerCommand(CLOSE_POLYGONS_COMMAND_ID, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("Нет открытого редактора");
            return;
        }
        
        const doc = editor.document;
        const fileName = doc.fileName.toLowerCase();
        
        // Проверяем, что это GeoJSON файл
        if (!fileName.endsWith('.geojson') && !fileName.endsWith('.json')) {
            vscode.window.showWarningMessage("Команда работает только с GeoJSON файлами (.geojson, .json)");
            return;
        }
        
        try {
            const content = doc.getText();
            
            // Нормализуем GeoJSON
            const normalized = normalizeGeoJSONGeometries(content);
            
            // Проверяем, были ли внесены изменения
            // Сравниваем нормализованные JSON для учета различий в форматировании
            try {
                const originalParsed = JSON.parse(content);
                const normalizedParsed = JSON.parse(normalized);
                const originalString = JSON.stringify(originalParsed);
                const normalizedString = JSON.stringify(normalizedParsed);
                
                if (originalString === normalizedString) {
                    vscode.window.showInformationMessage("Незамкнутые контуры не найдены");
                    return;
                }
            } catch (e) {
                // Если не удалось распарсить, сравниваем как строки
                if (normalized === content) {
                    vscode.window.showInformationMessage("Незамкнутые контуры не найдены");
                    return;
                }
            }
            
            // Обновляем документ
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(content.length)
            );
            edit.replace(doc.uri, fullRange, normalized);
            
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                // Сохраняем документ
                await doc.save();
                vscode.window.showInformationMessage("Полигоны успешно замкнуты");
            } else {
                vscode.window.showErrorMessage("Не удалось применить изменения");
            }
        } catch (error: any) {
            vscode.window.showErrorMessage("Ошибка при замыкании полигонов: " + error.message);
        }
    });

    // Подписка на изменения документов для live preview
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
        // Игнорируем изменения в негеопространственных файлах
        const fileName = e.document.fileName.toLowerCase();
        const supportedExtensions = ['.geojson', '.json', '.kml', '.csv', '.gpx', '.igc', '.gml', '.txt'];
        const isSupported = supportedExtensions.some(ext => fileName.endsWith(ext));
        
        if (!isSupported) {
            return;
        }
        
        const docUriString = e.document.uri.toString();
        const panel = previewPanels.get(docUriString);
        
        if (panel) {
            // Обновляем виртуальный документ
            const previewUri = makePreviewUri(e.document);
            provider.triggerVirtualDocumentChange(previewUri);
            
            // Отправляем сообщение в webview для обновления данных
            panel.webview.postMessage({
                command: 'updatePreview'
            });
        }
    });

    const simplifyGeometriesCommand = vscode.commands.registerCommand(SIMPLIFY_GEOMETRIES_COMMAND_ID, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("Нет открытого редактора");
            return;
        }
        
        const doc = editor.document;
        const fileName = doc.fileName.toLowerCase();
        
        // Проверяем, что это GeoJSON файл
        if (!fileName.endsWith('.geojson') && !fileName.endsWith('.json')) {
            vscode.window.showWarningMessage("Команда работает только с GeoJSON файлами (.geojson, .json)");
            return;
        }
        
        try {
            const content = doc.getText();
            
            // Упрощаем GeoJSON (округляем координаты до тысячных и удаляем дубликаты)
            // Используем функцию из preview.js через webview, если он открыт
            const docUriString = doc.uri.toString();
            const panel = previewPanels.get(docUriString);
            
            if (panel) {
                // Если панель предпросмотра открыта, отправляем сообщение в webview
                panel.webview.postMessage({
                    command: 'simplifyGeometries'
                });
            } else {
                // Если панель не открыта, используем функцию напрямую из extension
                // Но функция simplifyGeoJSONGeometries находится в preview.js, поэтому
                // нужно либо дублировать логику, либо открыть панель предпросмотра
                vscode.window.showWarningMessage("Откройте предпросмотр карты для использования этой функции");
            }
        } catch (error) {
            vscode.window.showErrorMessage('Ошибка при упрощении геометрий: ' + error.message);
        }
    });

    context.subscriptions.push(previewCommand, previewWithProjCommand, closePolygonsCommand, simplifyGeometriesCommand, registration, changeDocumentSubscription);
}

// this method is called when your extension is deactivated
export function deactivate() {

}