function renderFeaturesHtml(selFeatures) {
    let html = "<div>";
    html += "<table>";
    let showFeatureHeader = (selFeatures.length > 1);

    let noAttributeCount = 0;
    for (let i = 0; i < selFeatures.length; i++) {
        let feat = selFeatures[i];
        let names = feat.getKeys();
        if (names.length == 1 && names[0] == feat.getGeometryName()) {
            noAttributeCount++;
        }
    }

    if (noAttributeCount == selFeatures.length) {
        return null;
    }

    for (let i = 0; i < selFeatures.length; i++) {
        let feat = selFeatures[i];
        if (showFeatureHeader) {
            html += "<tr><td colspan='2'>Feature" + (i + 1) + "</td></tr>";
        }
        let props = feat.getProperties();
        for (let key in props) {
            //Skip geometry
            if (key == feat.getGeometryName()) {
                continue;
            }
            const sk = DOMPurify.sanitize(key);
            const sv = DOMPurify.sanitize(props[key]);
            html += "<tr>";
            html += "<td class='popup-attribute-key' title='" + sk + "' style='max-width: 20ch;text-overflow: ellipsis;overflow: hidden;white-space: nowrap;'>" + sk + "</td>";
            html += "<td class='popup-attribute-value' title='" + sv + "' style='max-width: 30ch;text-overflow: ellipsis;overflow: hidden;white-space: nowrap;'>" + sv + "</td>";
            html += "</tr>";
        }
    }
    html += "</table>";
    html += "</div>";
    return html;
}

function strIsNullOrEmpty(str) {
    return str == null || str == "";
}

function tryReadCSVFeatures(previewSettings, previewContent, formatOptions, callback) {
    let aliases = previewSettings.csvColumnAliases;
    Papa.parse(previewContent, {
        header: true,
        complete: function (results) {
            if (!results.data || results.data.length == 0) {
                callback({ error: "No data parsed. Probably not a CSV file" });
            } else {
                if (results.meta.fields) {
                    let parsed = null;
                    //Run through the alias list and see if we get any matches
                    //for (let alias of aliases) {
                    aliases.forEach(function (alias) {
                        if (parsed) {
                            return;
                        }
                        let xc = results.meta.fields.filter(function (s) { return s.toLowerCase() == alias.xColumn.toLowerCase(); })[0];
                        let yc = results.meta.fields.filter(function (s) { return s.toLowerCase() == alias.yColumn.toLowerCase(); })[0];
                        // We found the columns, but before we accept this set, the columns
                        // in question must be numeric. Being CSV and all, we'll use the most
                        // scientific method to determine this: Sample the first row of data /s
                        if (!strIsNullOrEmpty(xc) && !strIsNullOrEmpty(yc)) {
                            let first = results.data[0];
                            let firstX = parseFloat(first[xc]);
                            let firstY = parseFloat(first[yc]);
                            if (first && !isNaN(firstX) && !isNaN(firstY)) {
                                let json = {
                                    type: 'FeatureCollection',
                                    features: []
                                };
                                results.data.forEach(function (d) {
                                    let x = parseFloat(d[xc]);
                                    let y = parseFloat(d[yc]);
                                    if (!isNaN(x) && !isNaN(y)) {
                                        let f = {
                                            type: 'Feature',
                                            geometry: {
                                                coordinates: [x, y],
                                                type: 'Point'
                                            },
                                            properties: d
                                        }
                                        delete f.properties[xc];
                                        delete f.properties[yc];
                                        json.features.push(f);
                                    }
                                });
                                let fmt = new ol.format.GeoJSON();
                                parsed = fmt.readFeatures(json, formatOptions);
                                return;
                            }
                        }
                    });
                    if (parsed) {
                        callback({ features: parsed });
                    } else {
                        callback({ error: "Data successfully parsed as CSV, but coordinate columns could not be found" });
                    }
                } else {
                    callback({ error: "No fields found in CSV metadata" });
                }
            }
        }
    })
}

function tryReadFeatures(format, text, options) {
    try {
        return format.readFeatures(text, options);
    } catch (e) {
        return null;
    }
}

function tryReadWKTFeatures(format, text, options) {
    try {
        // WKT format uses readGeometry instead of readFeatures
        // We need to wrap the geometry in a Feature
        // Trim whitespace and newlines from the text before parsing
        const trimmedText = text.trim();
        if (!trimmedText) {
            return null;
        }
        const geometry = format.readGeometry(trimmedText, options);
        if (geometry) {
            const feature = new ol.Feature({
                geometry: geometry
            });
            return [feature];
        }
        return null;
    } catch (e) {
        return null;
    }
}

function normalizeGeoJSON(content) {
    try {
        const parsed = JSON.parse(content);
        // Check if it's an array of feature-like objects
        if (Array.isArray(parsed) && parsed.length > 0) {
            // Check if first element looks like a Feature (has geometry property)
            const firstItem = parsed[0];
            if (firstItem && typeof firstItem === 'object' && firstItem.geometry) {
                // Ensure each feature has type: "Feature" and normalize structure
                const normalizedFeatures = parsed.map(item => {
                    if (item.type !== 'Feature') {
                        return {
                            type: 'Feature',
                            geometry: item.geometry,
                            properties: item.properties || {}
                        };
                    }
                    return item;
                });
                // Wrap array in FeatureCollection
                return JSON.stringify({
                    type: 'FeatureCollection',
                    features: normalizedFeatures
                });
            }
        }
        // Return original content if not an array of features
        return content;
    } catch (e) {
        // If JSON parsing fails, return original content
        return content;
    }
}

function createPreviewSource(previewContent, formatOptions, previewSettings, callback) {
    let projections = previewSettings.projections || [];
    if (projections.length > 0) {
        for (let i = 0; i < projections.length; i++) {
            let pj = projections[i];
            proj4.defs("EPSG:" + pj.epsgCode, pj.definition);
        }
        ol.proj.proj4.register(proj4);
    }
    let formats = {
        "GPX": ol.format.GPX,
        "GeoJSON": ol.format.GeoJSON,
        "IGC": ol.format.IGC,
        "KML": ol.format.KML,
        "TopoJSON": ol.format.TopoJSON,
        "WFS": ol.format.WFS,
        "GML": ol.format.GML,
        "GML2": ol.format.GML2,
        "GML3": ol.format.GML3,
        "WKT": ol.format.WKT
    };
    let features = null;
    let driverName = null;
    // CSV has no dedicated OL format driver. It requires a combination of papaparse and feeding
    // its parsed result (if successful) to the GeoJSON format driver. Thus we will test for this
    // format first before trying the others one-by-one
    tryReadCSVFeatures(previewSettings, previewContent, formatOptions, function (res) {
        features = res.features;
        if (features && features.length > 0) {
            driverName = "CSV";
        } else {
            for (let formatName in formats) {
                let format = formats[formatName];
                let driver = new format();
                // Normalize GeoJSON if it's an array of features
                let contentToParse = previewContent;
                if (formatName === "GeoJSON") {
                    contentToParse = normalizeGeoJSON(previewContent);
                }
                // WKT format uses readGeometry instead of readFeatures
                if (formatName === "WKT") {
                    features = tryReadWKTFeatures(driver, contentToParse, formatOptions);
                } else {
                    features = tryReadFeatures(driver, contentToParse, formatOptions);
                }
                if (features && features.length > 0) {
                    driverName = formatName;
                    break;
                }
            }
        }
        if (!features || features.length == 0) {
            let attemptedFormats = ["CSV"].concat(Object.keys(formats));
            throw new Error("Could not load preview content. Attempted the following formats:<br/><br/><ul><li>" + attemptedFormats.join("</li><li>") + "</ul></li><p>Please make sure your document content is one of the above formats</p>");
        }
        const source = new ol.source.Vector({
            features: features,
            //This is needed for features that cross the intl date line to display properly since we aren't fixing our viewport to one
            //particular view of the world and OL wraps to one earth's flattened viewport.
            wrapX: false
        });
        // Сохраняем исходный порядок features для правильного отображения в панели информации
        source.originalFeatures = features.slice();
        callback({
            source: source,
            driver: driverName
        });
    });
}

function makeSelectInteraction(previewSettings) {
    let polygonStyle = new ol.style.Style({
        stroke: new ol.style.Stroke(previewSettings.selectionStyle.polygon.stroke),
        fill: new ol.style.Fill(previewSettings.selectionStyle.polygon.fill)
    });
    let lineStyle = new ol.style.Style({
        fill: new ol.style.Stroke({
            color: previewSettings.selectionStyle.line.stroke.color
        }),
        stroke: new ol.style.Stroke(previewSettings.selectionStyle.line.stroke)
    });
    let pointStyle = new ol.style.Style({
        image: new ol.style.Circle({
            radius: previewSettings.selectionStyle.point.radius || 5,
            stroke: new ol.style.Stroke(previewSettings.selectionStyle.point.stroke),
            fill: new ol.style.Fill(previewSettings.selectionStyle.point.fill)
        })
    });
    return new ol.interaction.Select({
        style: function (feature, resolution) {
            let geom = feature.getGeometry();
            if (geom) {
                let geomType = geom.getType();
                if (geomType.indexOf("Polygon") >= 0) {
                    return polygonStyle;
                } else if (geomType.indexOf("Line") >= 0) {
                    return lineStyle;
                } else if (geomType.indexOf("Point") >= 0) {
                    return pointStyle;
                }
            }
            return null;
        }
    });
}

function vertexImage(color, previewSettings) {
    return new ol.style.Circle({
        radius: previewSettings.style.vertex.radius,
        fill: new ol.style.Fill({
            color: color
        })
    });
}
function pointImage(color, previewSettings) {
    return new ol.style.Circle({
        radius: previewSettings.style.point.radius || 5,
        stroke: new ol.style.Stroke({
            color: color,
            width: previewSettings.style.point.stroke.width
        }),
        fill: new ol.style.Fill(previewSettings.style.point.fill)
    });
}

function clamp(value, min, max) {
    return Math.min(Math.max(min, value), max);
}

// support SimpleStyle for lines
function lineWithSimpleStyle(lineStyle, feature, previewSettings) {
    const properties = feature.getProperties();
    const color = properties['stroke'];
    if (color) {
        const sc = [...ol.color.asArray(color)];
        if (properties['stroke-opacity']) {
            sc[3] = clamp(properties['stroke-opacity'], 0.0, 1.0);
        }
        lineStyle[0].getStroke().setColor(sc);
        if (lineStyle.length > 1) {
            lineStyle[1].setImage(vertexImage(sc, previewSettings));
        }
    }
    const width = properties['stroke-width'];
    if (width) {
        lineStyle[0].getStroke().setWidth(width);
    }
    return lineStyle;
}

// support SimpleStyle for polygons
function polygonWithSimpleStyle(polygonStyle, feature, previewSettings) {
    const properties = feature.getProperties();
    const color = properties['stroke'];
    if (color) {
        const sc = [...ol.color.asArray(color)];
        if (properties['stroke-opacity']) {
            sc[3] = clamp(properties['stroke-opacity'], 0.0, 1.0);
        }
        polygonStyle[0].getStroke().setColor(sc);
        if (polygonStyle.length > 1) {
            polygonStyle[1].setImage(vertexImage(sc, previewSettings));
        }
    }
    const width = properties['stroke-width'];
    if (width) {
        polygonStyle[0].getStroke().setWidth(width);
    }
    const fillColor = properties['fill'];
    if (fillColor) {
        const fc = [...ol.color.asArray(fillColor)];
        if (properties['fill-opacity']) {
            fc[3] = clamp(properties['fill-opacity'], 0.0, 1.0);
        }
        polygonStyle[0].getFill().setColor(fc);
    }

    return polygonStyle;
}

// support SimpleStyle for points
function pointWithSimpleStyle(pointStyle, feature, previewSettings) {
    const properties = feature.getProperties();
    const color = properties['marker-color'];
    if (color) {
        const mc = [...ol.color.asArray(color)];
        pointStyle.setImage(pointImage(mc, previewSettings));
    }
    return pointStyle;
}

async function setupLayers(previewSettings) {
    const baseLayers = [];
    if (previewSettings.customLayers && Array.isArray(previewSettings.customLayers.base)) {
        for (const bldef of previewSettings.customLayers.base) {
            const sourceParms = Object.fromEntries(bldef.sourceParams
                .filter(sp => sp.name.indexOf(bldef.kind) < 0)
                .map(kvp => ([kvp.name, kvp.value]))
            );
            switch (bldef.kind) {
                case "xyz":
                    baseLayers.push(new ol.layer.Tile({
                        title: bldef.name,
                        type: 'base',
                        visible: false,
                        source: new ol.source.XYZ(sourceParms)
                    }));
                    break;
                case "wmts":
                    const capsUrl = bldef.sourceParams.find(sp => sp.name === 'wmts:capabilitiesUrl')?.value;
                    if (!capsUrl) {
                        console.warn(`Missing required wmts:capabilitiesUrl source parameter`);
                    } else {
                        const capsR = await fetch(capsUrl);
                        const capsRText = await capsR.text();
                        const parser = new ol.format.WMTSCapabilities();
                        const capsParsed = parser.read(capsRText);
                        const wmtsOptions = ol.source.WMTS.optionsFromCapabilities(capsParsed, sourceParms);
                        baseLayers.push(new ol.layer.Tile({
                            title: bldef.name,
                            type: 'base',
                            visible: false,
                            source: new ol.source.WMTS(wmtsOptions)
                        }));
                    }
                    break;
                default:
                    console.warn(`Unsupported base layer kind: ${bldef.kind}`);
                    break;
            }
        }
    }

    if (previewSettings.apikeys.stadiamaps) {
        baseLayers.push(new ol.layer.Tile({
            title: 'Stamen Toner',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "stamen-toner"),
            source: new ol.source.StadiaMaps ({
                layer: 'stamen_toner',
                apiKey: previewSettings.apikeys.stadiamaps
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Stamen Watercolor',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "stamen-water"),
            source: new ol.source.StadiaMaps ({
                layer: 'stamen_watercolor',
                apiKey: previewSettings.apikeys.stadiamaps
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Stamen Terrain',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "stamen-terrain"),
            source: new ol.source.StadiaMaps ({
                layer: 'stamen_terrain',
                apiKey: previewSettings.apikeys.stadiamaps
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Stadia Maps Alidade Smooth',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "stadia-alidade-smooth"),
            source: new ol.source.StadiaMaps ({
                layer: 'alidade_smooth',
                apiKey: previewSettings.apikeys.stadiamaps
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Stadia Maps Alidade Smooth Dark',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "stadia-alidade-smooth-dark"),
            source: new ol.source.StadiaMaps ({
                layer: 'alidade_smooth_dark',
                apiKey: previewSettings.apikeys.stadiamaps
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Stadia Maps Outdoors',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "stadia-outdoors"),
            source: new ol.source.StadiaMaps ({
                layer: 'outdoors',
                apiKey: previewSettings.apikeys.stadiamaps
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Stadia Maps OSM Bright',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "stadia-osm-bright"),
            source: new ol.source.StadiaMaps ({
                layer: 'osm_bright',
                apiKey: previewSettings.apikeys.stadiamaps
            })
        }));
    }
    if (previewSettings.apikeys.bing) {
        baseLayers.push(new ol.layer.Tile({
            title: 'Bing Maps - Road',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "bing-road"),
            source: new ol.source.BingMaps ({
                imagerySet: 'RoadOnDemand',
                key: previewSettings.apikeys.bing
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Bing Maps - Aerials',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "bing-aerial"),
            source: new ol.source.BingMaps ({
                imagerySet: 'Aerial',
                key: previewSettings.apikeys.bing
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Bing Maps - Aerials with Labels',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "bing-aerial-with-labels"),
            source: new ol.source.BingMaps ({
                imagerySet: 'AerialWithLabelsOnDemand',
                key: previewSettings.apikeys.bing
            })
        }));
        baseLayers.push(new ol.layer.Tile({
            title: 'Bing Maps - Dark',
            type: 'base',
            visible: (previewSettings.defaultBaseLayer == "bing-canvas-dark"),
            source: new ol.source.BingMaps ({
                imagerySet: 'CanvasDark',
                key: previewSettings.apikeys.bing
            })
        }));
    }
    baseLayers.push(new ol.layer.Tile({
        title: 'OpenStreetMap',
        type: 'base',
        visible: (previewSettings.defaultBaseLayer == "osm"),
        source: new ol.source.OSM()
    }));
    return baseLayers;
}

function loadingDone() {
    const el = document.getElementById("loading-mask");
    el.remove();
}

// Функция для конвертации OpenLayers геометрии в GeoJSON
function olGeometryToGeoJSON(geom) {
    const format = new ol.format.GeoJSON();
    return format.writeGeometryObject(geom);
}

// Функция для получения проекции из OpenLayers геометрии или источника
function getGeometryProjection(olGeometry, source) {
    if (!olGeometry && !source) {
        return null;
    }
    
    try {
        // Пытаемся получить проекцию из геометрии
        if (olGeometry) {
            // OpenLayers геометрии обычно не имеют метода getProjection()
            // Но можем попробовать получить из источника
        }
        
        // Пытаемся получить проекцию из источника
        if (source) {
            // Проверяем, есть ли у источника проекция
            if (source.getProjection) {
                const proj = source.getProjection();
                if (proj) {
                    return proj.getCode();
                }
            }
        }
        
        // Если не удалось получить проекцию, возвращаем null
        return null;
    } catch (e) {
        console.warn('Error getting projection:', e);
        return null;
    }
}

// Функция для преобразования координат в EPSG:4326 (WGS84)
// Принимает координаты и опциональную проекцию источника
function transformToWGS84(coord, sourceProjection = null) {
    if (!coord || !Array.isArray(coord) || coord.length < 2) {
        return coord;
    }
    
    try {
        const lon = coord[0];
        const lat = coord[1];
        
        // Проверяем, не являются ли координаты уже в EPSG:4326
        // Географические координаты: lon в диапазоне -180..180, lat в диапазоне -90..90
        if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
            return coord;
        }
        
        // Если координаты выходят за пределы географических координат, 
        // вероятно, они в проекции (например, Web Mercator EPSG:3857)
        let fromProj = sourceProjection;
        
        // Если проекция не указана, пытаемся определить по значениям координат
        if (!fromProj) {
            // Web Mercator (EPSG:3857) имеет координаты в диапазоне примерно -20037508..20037508
            // Другие проекции также могут иметь большие значения
            if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
                // Вероятно, это проекция карты - используем EPSG:3857 по умолчанию
                // (самая распространенная проекция для веб-карт)
                fromProj = 'EPSG:3857';
            }
        }
        
        // Если проекция определена и отличается от EPSG:4326, преобразуем
        if (fromProj && fromProj !== 'EPSG:4326') {
            try {
                if (typeof ol !== 'undefined' && ol.proj && ol.proj.transform) {
                    const transformed = ol.proj.transform([lon, lat], fromProj, 'EPSG:4326');
                    if (transformed && transformed.length >= 2) {
                        return transformed;
                    }
                }
            } catch (e) {
                console.warn('Error transforming coordinates from', fromProj, 'to EPSG:4326:', e);
                // Если преобразование не удалось, возвращаем исходные координаты
                return coord;
            }
        }
        
        return coord;
    } catch (e) {
        console.error('Error in transformToWGS84:', e);
        return coord;
    }
}

// Функция для поиска ближайшей координаты в OpenLayers геометрии
// Используется для получения правильных координат ошибки из OpenLayers геометрии
function findNearestCoordinateInOLGeometry(olGeometry, errorX, errorY) {
    if (!olGeometry) {
        return null;
    }
    
    let nearestCoord = null;
    let minDistance = Infinity;
    
    // Рекурсивная функция для обхода всех координат в геометрии
    function traverseCoordinates(coords) {
        if (!Array.isArray(coords)) {
            return;
        }
        
        // Если это массив координат [x, y] или [x, y, z]
        if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            const coordX = coords[0];
            const coordY = coords[1];
            
            // Вычисляем расстояние до точки ошибки
            const dx = coordX - errorX;
            const dy = coordY - errorY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < minDistance) {
                minDistance = distance;
                nearestCoord = [coordX, coordY];
            }
        } else {
            // Рекурсивно обходим вложенные массивы
            for (let i = 0; i < coords.length; i++) {
                traverseCoordinates(coords[i]);
            }
        }
    }
    
    try {
        // Получаем координаты из OpenLayers геометрии
        const coords = olGeometry.getCoordinates();
        if (coords) {
            traverseCoordinates(coords);
        }
    } catch (e) {
        console.error('Error traversing OL geometry:', e);
        return null;
    }
    
    // Если нашли ближайшую точку, возвращаем её
    // Используем относительное расстояние для определения совпадения
    // Вычисляем примерный размер геометрии для нормализации расстояния
    try {
        const extent = olGeometry.getExtent();
        if (extent && extent.length === 4) {
            const width = extent[2] - extent[0];
            const height = extent[3] - extent[1];
            const diagonal = Math.sqrt(width * width + height * height);
            
            // Используем 1% от диагонали геометрии как порог
            const threshold = diagonal * 0.01;
            
            if (nearestCoord && minDistance < threshold) {
                return nearestCoord;
            }
        }
    } catch (e) {
        // Если не удалось вычислить extent, используем абсолютный порог
        // Для EPSG:3857 это примерно 1000 метров, для EPSG:4326 - примерно 0.01 градуса
        const threshold = 1000; // Более либеральный порог
        if (nearestCoord && minDistance < threshold) {
            return nearestCoord;
        }
    }
    
    return null;
}

// Функция для получения координаты по индексу вершины в геометрии
// errorPos - это индекс вершины в последовательности всех координат геометрии
function getCoordinateByIndex(geomGeoJSON, olGeometry, errorPos) {
    // Сначала пытаемся использовать OpenLayers геометрию
    if (olGeometry) {
        try {
            const coords = olGeometry.getCoordinates();
            if (coords) {
                // Рекурсивно собираем все координаты в плоский массив
                function flattenCoordinates(coords, result) {
                    if (!Array.isArray(coords)) {
                        return;
                    }
                    
                    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                        result.push(coords.slice(0, 2));
                    } else {
                        for (let i = 0; i < coords.length; i++) {
                            flattenCoordinates(coords[i], result);
                        }
                    }
                }
                
                const flatCoords = [];
                flattenCoordinates(coords, flatCoords);
                
                if (errorPos >= 0 && errorPos < flatCoords.length) {
                    return flatCoords[errorPos];
                }
            }
        } catch (e) {
            console.error('Error getting coordinate by index from OL geometry:', e);
        }
    }
    
    // Fallback: используем GeoJSON
    if (geomGeoJSON && geomGeoJSON.coordinates) {
        try {
            // Рекурсивно собираем все координаты в плоский массив
            function flattenGeoJSONCoordinates(coords, result) {
                if (!Array.isArray(coords)) {
                    return;
                }
                
                if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                    result.push(coords.slice(0, 2));
                } else {
                    for (let i = 0; i < coords.length; i++) {
                        flattenGeoJSONCoordinates(coords[i], result);
                    }
                }
            }
            
            const flatCoords = [];
            flattenGeoJSONCoordinates(geomGeoJSON.coordinates, flatCoords);
            
            if (errorPos >= 0 && errorPos < flatCoords.length) {
                return flatCoords[errorPos];
            }
        } catch (e) {
            console.error('Error getting coordinate by index from GeoJSON:', e);
        }
    }
    
    return null;
}

// Функция для поиска ближайшей координаты в исходной геометрии GeoJSON
// Используется для получения правильных координат ошибки из исходного GeoJSON
function findNearestCoordinateInGeometry(geomGeoJSON, errorX, errorY) {
    if (!geomGeoJSON || !geomGeoJSON.coordinates) {
        return null;
    }
    
    let nearestCoord = null;
    let minDistance = Infinity;
    
    // Рекурсивная функция для обхода всех координат в геометрии
    function traverseCoordinates(coords, depth) {
        if (!Array.isArray(coords)) {
            return;
        }
        
        // Если это массив координат [x, y] или [x, y, z]
        if (depth > 0 && coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            const coordX = coords[0];
            const coordY = coords[1];
            
            // Вычисляем расстояние до точки ошибки
            const dx = coordX - errorX;
            const dy = coordY - errorY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < minDistance) {
                minDistance = distance;
                nearestCoord = [coordX, coordY];
            }
        } else {
            // Рекурсивно обходим вложенные массивы
            for (let i = 0; i < coords.length; i++) {
                traverseCoordinates(coords[i], depth + 1);
            }
        }
    }
    
    // Обрабатываем разные типы геометрий
    switch (geomGeoJSON.type) {
        case 'Point':
            if (geomGeoJSON.coordinates && geomGeoJSON.coordinates.length >= 2) {
                return geomGeoJSON.coordinates.slice(0, 2);
            }
            break;
            
        case 'LineString':
        case 'MultiPoint':
            traverseCoordinates(geomGeoJSON.coordinates, 0);
            break;
            
        case 'Polygon':
        case 'MultiLineString':
            traverseCoordinates(geomGeoJSON.coordinates, 0);
            break;
            
        case 'MultiPolygon':
            traverseCoordinates(geomGeoJSON.coordinates, 0);
            break;
    }
    
    // Если нашли ближайшую точку, возвращаем её
    // Используем более либеральный порог, так как координаты могут быть в разных системах координат
    // Вычисляем примерный размер геометрии для нормализации расстояния
    try {
        // Пытаемся вычислить bounding box геометрии
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        function findBounds(coords, depth) {
            if (!Array.isArray(coords)) {
                return;
            }
            
            if (depth > 0 && coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                minX = Math.min(minX, coords[0]);
                minY = Math.min(minY, coords[1]);
                maxX = Math.max(maxX, coords[0]);
                maxY = Math.max(maxY, coords[1]);
            } else {
                for (let i = 0; i < coords.length; i++) {
                    findBounds(coords[i], depth + 1);
                }
            }
        }
        
        findBounds(geomGeoJSON.coordinates, 0);
        
        if (minX !== Infinity && minY !== Infinity) {
            const width = maxX - minX;
            const height = maxY - minY;
            const diagonal = Math.sqrt(width * width + height * height);
            
            // Используем 5% от диагонали геометрии как порог
            const threshold = diagonal * 0.05;
            
            if (nearestCoord && minDistance < threshold) {
                return nearestCoord;
            }
        }
    } catch (e) {
        // Если не удалось вычислить bounds, используем абсолютный порог
        // Более либеральный порог для учета разных систем координат
        const threshold = 0.01; // 0.01 градуса или единиц координат
        if (nearestCoord && minDistance < threshold) {
            return nearestCoord;
        }
    }
    
    return null;
}

// Функция для проверки структуры GeoJSON (базовая проверка формата)
function validateGeoJSONStructure(geomGeoJSON) {
    const errors = [];
    
    // Проверка наличия обязательных полей
    if (!geomGeoJSON || typeof geomGeoJSON !== 'object') {
        errors.push('Геометрия должна быть объектом');
        return errors;
    }
    
    if (!geomGeoJSON.type) {
        errors.push('Отсутствует поле "type"');
        return errors;
    }
    
    // Проверка типа геометрии
    const validTypes = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'];
    if (validTypes.indexOf(geomGeoJSON.type) === -1) {
        errors.push(`Неизвестный тип геометрии: ${geomGeoJSON.type}`);
    }
    
    // Проверка наличия coordinates для всех типов кроме GeometryCollection
    if (geomGeoJSON.type !== 'GeometryCollection') {
        if (!geomGeoJSON.coordinates) {
            errors.push('Отсутствует поле "coordinates"');
        } else if (!Array.isArray(geomGeoJSON.coordinates)) {
            errors.push('Поле "coordinates" должно быть массивом');
        }
    }
    
    // Проверка координат для разных типов геометрий
    // Упрощенная проверка - только базовая валидация структуры
    // Детальную проверку координат выполнит JSTS при чтении геометрии
    if (geomGeoJSON.coordinates && Array.isArray(geomGeoJSON.coordinates)) {
        // Для Point координаты должны быть массивом чисел
        if (geomGeoJSON.type === 'Point') {
            if (geomGeoJSON.coordinates.length < 2 || geomGeoJSON.coordinates.length > 3) {
                errors.push('Point должен содержать 2 или 3 координаты [x, y] или [x, y, z]');
            } else if (!geomGeoJSON.coordinates.every(c => typeof c === 'number' && !isNaN(c))) {
                errors.push('Координаты Point должны быть числами');
            }
        }
        // Для остальных типов проверяем только, что это непустой массив
        // Детальную структуру проверит JSTS
        else if (geomGeoJSON.coordinates.length === 0) {
            errors.push(`Координаты для типа ${geomGeoJSON.type} не могут быть пустым массивом`);
        }
    }
    
    return errors;
}

// Функция для проверки простоты геометрии через IsSimpleOp
// Возвращает true, если геометрия простая (не имеет самопересечений)
function isSimpleGeoJSON(geomGeoJSON) {
    try {
        let jstsLib = null;
        if (typeof jsts !== 'undefined') {
            jstsLib = jsts;
        } else if (typeof window !== 'undefined' && window.jsts) {
            jstsLib = window.jsts;
        } else if (typeof self !== 'undefined' && self.jsts) {
            jstsLib = self.jsts;
        }
        
        if (!jstsLib || !jstsLib.io || !jstsLib.io.GeoJSONReader || !jstsLib.operation || !jstsLib.operation.valid) {
            return null; // JSTS недоступен
        }
        
        const reader = new jstsLib.io.GeoJSONReader();
        let geometryToValidate = geomGeoJSON;
        
        if (geometryToValidate.type === 'Feature') {
            geometryToValidate = geometryToValidate.geometry;
        }
        
        const jstsGeometry = reader.read(geometryToValidate);
        if (!jstsGeometry) {
            return null;
        }
        
        const IsSimpleOp = jstsLib.operation.valid.IsSimpleOp;
        if (IsSimpleOp) {
            const isSimpleOp = new IsSimpleOp(jstsGeometry);
            return isSimpleOp.isSimple();
        }
        
        return null;
    } catch (e) {
        console.error('Error checking simplicity:', e);
        return null;
    }
}

// Функция для проверки валидности геометрии через IsValidOp
// Возвращает true, если геометрия валидна согласно OGC Simple Feature Access
function isValidGeoJSON(geomGeoJSON) {
    try {
        let jstsLib = null;
        if (typeof jsts !== 'undefined') {
            jstsLib = jsts;
        } else if (typeof window !== 'undefined' && window.jsts) {
            jstsLib = window.jsts;
        } else if (typeof self !== 'undefined' && self.jsts) {
            jstsLib = self.jsts;
        }
        
        if (!jstsLib || !jstsLib.io || !jstsLib.io.GeoJSONReader || !jstsLib.operation || !jstsLib.operation.valid) {
            return null; // JSTS недоступен
        }
        
        const reader = new jstsLib.io.GeoJSONReader();
        let geometryToValidate = geomGeoJSON;
        
        if (geometryToValidate.type === 'Feature') {
            geometryToValidate = geometryToValidate.geometry;
        }
        
        const jstsGeometry = reader.read(geometryToValidate);
        if (!jstsGeometry) {
            return null;
        }
        
        const IsValidOp = jstsLib.operation.valid.IsValidOp;
        if (IsValidOp) {
            const isValidOp = new IsValidOp(jstsGeometry);
            return isValidOp.isValid();
        }
        
        return null;
    } catch (e) {
        console.error('Error checking validity:', e);
        return null;
    }
}

// Функция для поиска точек самопересечения через GeometryGraph и ConsistentAreaTester
// Возвращает массив координат точек самопересечения [[x1, y1], [x2, y2], ...]
function findSelfIntersects(geomGeoJSON) {
    try {
        let jstsLib = null;
        if (typeof jsts !== 'undefined') {
            jstsLib = jsts;
        } else if (typeof window !== 'undefined' && window.jsts) {
            jstsLib = window.jsts;
        } else if (typeof self !== 'undefined' && self.jsts) {
            jstsLib = self.jsts;
        }
        
        if (!jstsLib || !jstsLib.io || !jstsLib.io.GeoJSONReader || !jstsLib.geomgraph || !jstsLib.operation || !jstsLib.operation.valid) {
            return []; // JSTS недоступен или не содержит нужных классов
        }
        
        const reader = new jstsLib.io.GeoJSONReader();
        let geometryToValidate = geomGeoJSON;
        
        if (geometryToValidate.type === 'Feature') {
            geometryToValidate = geometryToValidate.geometry;
        }
        
        const jstsGeometry = reader.read(geometryToValidate);
        if (!jstsGeometry) {
            return [];
        }
        
        // Используем GeometryGraph и ConsistentAreaTester для поиска самопересечений
        const GeometryGraph = jstsLib.geomgraph.GeometryGraph;
        const ConsistentAreaTester = jstsLib.operation.valid.ConsistentAreaTester;
        
        if (!GeometryGraph || !ConsistentAreaTester) {
            return [];
        }
        
        const graph = new GeometryGraph(0, jstsGeometry);
        const cat = new ConsistentAreaTester(graph);
        
        if (!cat.isNodeConsistentArea()) {
            // Получаем точку самопересечения
            const invalidPoint = cat.getInvalidPoint();
            if (invalidPoint) {
                const coord = invalidPoint.getCoordinate ? invalidPoint.getCoordinate() : invalidPoint;
                if (coord) {
                    const x = coord.x !== undefined ? coord.x : (coord[0] !== undefined ? coord[0] : null);
                    const y = coord.y !== undefined ? coord.y : (coord[1] !== undefined ? coord[1] : null);
                    if (x !== null && y !== null) {
                        return [[x, y]];
                    }
                }
            }
        }
        
        return [];
    } catch (e) {
        console.error('Error finding self-intersections:', e);
        return [];
    }
}

// Функция для проверки валидности геометрии согласно OGC Simple Feature Access
// Использует JSTS для полной валидации, включая проверку самопересечений
// Возвращает объект {isValid: boolean, errors: string[], errorCoordinates: number[][]}
// Параметр olGeometry - опциональная OpenLayers геометрия для получения правильных координат
function isValidGeometry(geomGeoJSON, olGeometry = null) {
    try {
        // Сначала проверяем структуру GeoJSON
        const structureErrors = validateGeoJSONStructure(geomGeoJSON);
        if (structureErrors.length > 0) {
            return { 
                isValid: false, 
                errors: structureErrors, 
                errorCoordinates: [] 
            };
        }
        
        // Затем пытаемся использовать JSTS для валидации согласно OGC Simple Feature Access
        let jstsLib = null;
        if (typeof jsts !== 'undefined') {
            jstsLib = jsts;
        } else if (typeof window !== 'undefined' && window.jsts) {
            jstsLib = window.jsts;
        } else if (typeof self !== 'undefined' && self.jsts) {
            jstsLib = self.jsts;
        }
        
        if (jstsLib && jstsLib.io && jstsLib.io.GeoJSONReader && jstsLib.operation && jstsLib.operation.valid) {
            try {
                // Преобразуем GeoJSON в JSTS геометрию
                const reader = new jstsLib.io.GeoJSONReader();
                let geometryToValidate = geomGeoJSON;
                
                // Если это Feature, извлекаем geometry
                if (geometryToValidate.type === 'Feature') {
                    geometryToValidate = geometryToValidate.geometry;
                }
                
                // Читаем геометрию из GeoJSON
                const jstsGeometry = reader.read(geometryToValidate);
                
                if (!jstsGeometry) {
                    return { isValid: false, errors: ['Не удалось прочитать геометрию'], errorCoordinates: [] };
                }
                
                // Используем IsValidOp для валидации согласно OGC Simple Feature Access
                const IsValidOp = jstsLib.operation.valid.IsValidOp;
                if (IsValidOp) {
                    const isValidOp = new IsValidOp(jstsGeometry);
                    const errors = [];
                    const errorCoordinates = [];
                    
                    // Сначала проверяем валидность
                    const isValid = isValidOp.isValid();
                    
                    // Дополнительно проверяем простоту геометрии через IsSimpleOp
                    const isSimple = isSimpleGeoJSON(geomGeoJSON);
                    if (isSimple === false) {
                        errors.push('Геометрия имеет самопересечения (не является простой)');
                        
                        // Пытаемся найти конкретные точки самопересечения
                        const selfIntersects = findSelfIntersects(geomGeoJSON);
                        if (selfIntersects && selfIntersects.length > 0) {
                            for (let i = 0; i < selfIntersects.length; i++) {
                                const intersectCoord = selfIntersects[i];
                                if (intersectCoord && intersectCoord.length >= 2) {
                                    // Пытаемся найти соответствующую координату в исходной геометрии
                                    let coordArray = null;
                                    
                                    if (olGeometry) {
                                        coordArray = findNearestCoordinateInOLGeometry(olGeometry, intersectCoord[0], intersectCoord[1]);
                                    }
                                    
                                    if (!coordArray) {
                                        coordArray = findNearestCoordinateInGeometry(geomGeoJSON, intersectCoord[0], intersectCoord[1]);
                                    }
                                    
                                    if (coordArray) {
                                        // Преобразуем координаты в EPSG:4326 перед добавлением
                                        const transformedCoord = transformToWGS84(coordArray);
                                        errorCoordinates.push(transformedCoord);
                                        errors.push(`Точка самопересечения: [${transformedCoord[0].toFixed(6)}, ${transformedCoord[1].toFixed(6)}]`);
                                    } else {
                                        // Используем координаты напрямую, если не удалось найти ближайшую
                                        // Преобразуем координаты в EPSG:4326 перед добавлением
                                        const transformedCoord = transformToWGS84(intersectCoord);
                                        errorCoordinates.push(transformedCoord);
                                        errors.push(`Точка самопересечения: [${transformedCoord[0].toFixed(6)}, ${transformedCoord[1].toFixed(6)}]`);
                                    }
                                }
                            }
                        }
                    }
                    
                    if (!isValid) {
                        // Используем getValidationError() как основной метод согласно документации JTS/JSTS
                        // Этот метод возвращает TopologyValidationError или null
                        if (typeof isValidOp.getValidationError === 'function') {
                            try {
                                const validationError = isValidOp.getValidationError();
                                if (validationError) {
                                    console.log('JSTS validationError:', validationError);
                                    
                                    // Получаем сообщение об ошибке через getMessage()
                                    if (typeof validationError.getMessage === 'function') {
                                        const errorMsg = validationError.getMessage();
                                        if (errorMsg) {
                                            errors.push(errorMsg);
                                        }
                                    } else if (validationError.message) {
                                        // Альтернативный способ получения сообщения
                                        errors.push(validationError.message);
                                    }
                                    
                                    // Получаем координаты ошибки через getCoordinate()
                                    if (typeof validationError.getCoordinate === 'function') {
                                        try {
                                            const coord = validationError.getCoordinate();
                                            console.log('JSTS validationError.getCoordinate():', coord);
                                            
                                            if (coord) {
                                                // Получаем координаты из JSTS Coordinate объекта
                                                const jstsX = coord.x !== undefined ? coord.x : (coord[0] !== undefined ? coord[0] : null);
                                                const jstsY = coord.y !== undefined ? coord.y : (coord[1] !== undefined ? coord[1] : null);
                                                
                                                if (jstsX !== null && jstsY !== null && !isNaN(jstsX) && !isNaN(jstsY)) {
                                                    // Пытаемся найти соответствующую координату в исходной геометрии
                                                    let coordArray = null;
                                                    
                                                    // Сначала пытаемся использовать OpenLayers геометрию, если она доступна
                                                    if (olGeometry) {
                                                        coordArray = findNearestCoordinateInOLGeometry(olGeometry, jstsX, jstsY);
                                                    }
                                                    
                                                    // Если не нашли через OpenLayers, ищем в GeoJSON
                                                    if (!coordArray) {
                                                        coordArray = findNearestCoordinateInGeometry(geomGeoJSON, jstsX, jstsY);
                                                    }
                                                    
                                                    if (coordArray) {
                                                        // Преобразуем координаты в EPSG:4326 перед добавлением
                                                        const transformedCoord = transformToWGS84(coordArray);
                                                        errorCoordinates.push(transformedCoord);
                                                        // Добавляем координаты к сообщению об ошибке, если его еще нет
                                                        if (errors.length === 0 || !errors[errors.length - 1].includes('[')) {
                                                            errors.push(`Координаты ошибки: [${transformedCoord[0].toFixed(6)}, ${transformedCoord[1].toFixed(6)}]`);
                                                        }
                                                    } else {
                                                        // Используем координаты напрямую, если не удалось найти ближайшую
                                                        // Преобразуем координаты в EPSG:4326 перед добавлением
                                                        const transformedCoord = transformToWGS84([jstsX, jstsY]);
                                                        errorCoordinates.push(transformedCoord);
                                                        if (errors.length === 0 || !errors[errors.length - 1].includes('[')) {
                                                            errors.push(`Координаты ошибки: [${transformedCoord[0].toFixed(6)}, ${transformedCoord[1].toFixed(6)}]`);
                                                        }
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            console.error('Error getting coordinate from validation error:', e);
                                        }
                                    }
                                    
                                    // Проверяем errorPos (индекс вершины) - дополнительный способ получения координат
                                    if (validationError.errorPos !== undefined && errorCoordinates.length === 0) {
                                        try {
                                            const errorPos = validationError.errorPos;
                                            console.log('JSTS validationError.errorPos:', errorPos);
                                            
                                            if (typeof errorPos === 'number' && errorPos >= 0) {
                                                const coordFromIndex = getCoordinateByIndex(geomGeoJSON, olGeometry, errorPos);
                                                if (coordFromIndex) {
                                                    // Преобразуем координаты в EPSG:4326 перед добавлением
                                                    const transformedCoord = transformToWGS84(coordFromIndex);
                                                    errorCoordinates.push(transformedCoord);
                                                    if (errors.length === 0 || !errors[errors.length - 1].includes('[')) {
                                                        errors.push(`Координаты ошибки (вершина ${errorPos}): [${transformedCoord[0].toFixed(6)}, ${transformedCoord[1].toFixed(6)}]`);
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            console.error('Error getting coordinate by errorPos from validationError:', e);
                                        }
                                    }
                                    
                                    // Если не получили координаты, но есть сообщение об ошибке, добавляем общее сообщение
                                    if (errorCoordinates.length === 0 && errors.length > 0) {
                                        errors.push('Не удалось определить точные координаты ошибки');
                                    }
                                } else {
                                    // Если getValidationError() вернул null, но isValid() вернул false,
                                    // это необычная ситуация, но добавляем общее сообщение
                                    errors.push('Геометрия невалидна (детали ошибки недоступны)');
                                }
                            } catch (e) {
                                console.error('Error calling getValidationError:', e);
                                errors.push('Ошибка при получении деталей валидации: ' + e.message);
                            }
                        } else {
                            // Если getValidationError() недоступен, используем fallback
                            errors.push('Геометрия невалидна (метод getValidationError недоступен)');
                        }
                        
                        // Дополнительная проверка через isValidDetail() как резервный метод
                        if (errors.length === 0 && typeof isValidOp.isValidDetail === 'function') {
                            try {
                                const validationResult = isValidOp.isValidDetail();
                                if (validationResult) {
                                    if (typeof validationResult.getErrorMessage === 'function') {
                                        const errorMsg = validationResult.getErrorMessage();
                                        if (errorMsg) {
                                            errors.push(errorMsg);
                                        }
                                    }
                                    
                                    if (typeof validationResult.getErrorLocation === 'function') {
                                        try {
                                            const errorLocation = validationResult.getErrorLocation();
                                            if (errorLocation) {
                                                let coord = null;
                                                
                                                if (typeof errorLocation.getCoordinate === 'function') {
                                                    coord = errorLocation.getCoordinate();
                                                } else if (errorLocation.x !== undefined && errorLocation.y !== undefined) {
                                                    coord = errorLocation;
                                                } else if (Array.isArray(errorLocation) && errorLocation.length >= 2) {
                                                    if (typeof errorLocation[0] === 'number' && typeof errorLocation[1] === 'number') {
                                                        const isLikelyCoordinate = Math.abs(errorLocation[0]) < 1000 && Math.abs(errorLocation[1]) < 1000;
                                                        if (isLikelyCoordinate) {
                                                            coord = { x: errorLocation[0], y: errorLocation[1] };
                                                        }
                                                    }
                                                }
                                                
                                                if (coord) {
                                                    const jstsX = coord.x !== undefined ? coord.x : (coord[0] !== undefined ? coord[0] : null);
                                                    const jstsY = coord.y !== undefined ? coord.y : (coord[1] !== undefined ? coord[1] : null);
                                                    
                                                    if (jstsX !== null && jstsY !== null) {
                                                        let coordArray = null;
                                                        if (olGeometry) {
                                                            coordArray = findNearestCoordinateInOLGeometry(olGeometry, jstsX, jstsY);
                                                        }
                                                        if (!coordArray) {
                                                            coordArray = findNearestCoordinateInGeometry(geomGeoJSON, jstsX, jstsY);
                                                        }
                                                        if (coordArray) {
                                                            // Преобразуем координаты в EPSG:4326 перед добавлением
                                                            const transformedCoord = transformToWGS84(coordArray);
                                                            errorCoordinates.push(transformedCoord);
                                                            errors.push(`Координаты ошибки: [${transformedCoord[0].toFixed(6)}, ${transformedCoord[1].toFixed(6)}]`);
                                                        }
                                                    }
                                                }
                                            }
                                        } catch (e) {
                                            console.error('Error getting error location:', e);
                                        }
                                    }
                                }
                            } catch (e) {
                                console.error('Error calling isValidDetail:', e);
                            }
                        }
                        
                        // Способ 3: Дополнительные проверки через OpenLayers для получения информации
                        if (errors.length === 0) {
                            try {
                                const format = new ol.format.GeoJSON();
                                const olGeom = format.readGeometry(geomGeoJSON);
                                const geomType = olGeom.getType();
                                
                                // Проверяем конкретные проблемы для разных типов геометрий
                                if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
                                    const coords = olGeom.getCoordinates();
                                    
                                    // Проверка на самопересечение через анализ координат
                                    if (coords && coords.length > 0) {
                                        // Для Polygon проверяем каждый контур
                                        if (geomType === 'Polygon') {
                                            for (let i = 0; i < coords.length; i++) {
                                                const ring = coords[i];
                                                if (ring && ring.length > 0) {
                                                    // Проверяем, замкнут ли контур
                                                    const first = ring[0];
                                                    const last = ring[ring.length - 1];
                                                    if (first[0] !== last[0] || first[1] !== last[1]) {
                                                        errors.push(`Контур ${i === 0 ? 'внешний' : 'внутренний ' + i} не замкнут`);
                                                    }
                                                    
                                                    // Проверяем минимальное количество точек
                                                    if (i === 0 && ring.length < 4) {
                                                        errors.push('Внешний контур должен содержать минимум 4 точки (включая замыкающую)');
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
                                    const coords = olGeom.getCoordinates();
                                    if (coords && coords.length > 0) {
                                        // Проверяем минимальное количество точек
                                        if (geomType === 'LineString' && coords.length < 2) {
                                            errors.push('LineString должен содержать минимум 2 точки');
                                        }
                                    }
                                }
                                
                                // Если не нашли конкретных проблем, добавляем общее сообщение
                                if (errors.length === 0) {
                                    errors.push('Геометрия не соответствует спецификации OGC Simple Feature Access (возможно самопересечение или другие топологические ошибки)');
                                }
                            } catch (olError) {
                                errors.push('Ошибка при анализе геометрии: ' + olError.message);
                            }
                        }
                    }
                    
                    return { isValid: isValid, errors: errors, errorCoordinates: errorCoordinates };
                } else {
                    // Альтернативный способ: используем метод isValid() напрямую на геометрии
                    if (typeof jstsGeometry.isValid === 'function') {
                        const isValid = jstsGeometry.isValid();
                        const errors = [];
                        
                        if (!isValid) {
                            // Пытаемся получить больше информации через анализ геометрии
                            try {
                                const format = new ol.format.GeoJSON();
                                const olGeom = format.readGeometry(geomGeoJSON);
                                const geomType = olGeom.getType();
                                
                                if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
                                    errors.push('Полигон невалиден (возможно самопересечение, незамкнутые контуры или другие топологические ошибки)');
                                } else {
                                    errors.push('Геометрия невалидна');
                                }
                            } catch (e) {
                                errors.push('Геометрия невалидна');
                            }
                        }
                        
                        return { 
                            isValid: isValid, 
                            errors: errors,
                            errorCoordinates: []
                        };
                    }
                }
            } catch (jstsError) {
                console.error('Error validating with JSTS:', jstsError);
                
                // Проверяем, является ли это ошибкой незамкнутого контура
                const errorMessage = jstsError.message || jstsError.toString() || '';
                const isUnclosedRingError = errorMessage.includes('Points of LinearRing do not form a closed linestring') ||
                                           errorMessage.includes('LinearRing') && errorMessage.includes('closed') ||
                                           errorMessage.includes('не замкнут') ||
                                           errorMessage.includes('unclosed');
                
                if (isUnclosedRingError) {
                    // Это ошибка незамкнутого контура
                    const errors = ['Контур не замкнут'];
                    const errorCoordinates = [];
                    
                    // Пытаемся найти координаты незамкнутого контура
                    try {
                        // Для полигонов проверяем первый и последний элемент каждого кольца
                        if (geomGeoJSON.type === 'Polygon' && geomGeoJSON.coordinates) {
                            geomGeoJSON.coordinates.forEach((ring, ringIndex) => {
                                if (ring && ring.length > 0) {
                                    const first = ring[0];
                                    const last = ring[ring.length - 1];
                                    
                                    // Если первая и последняя точки не совпадают, контур не замкнут
                                    if (first && last && first.length >= 2 && last.length >= 2) {
                                        const firstLon = first[0];
                                        const firstLat = first[1];
                                        const lastLon = last[0];
                                        const lastLat = last[1];
                                        
                                        // Проверяем, совпадают ли координаты (с небольшой погрешностью)
                                        const tolerance = 0.000001;
                                        if (Math.abs(firstLon - lastLon) > tolerance || Math.abs(firstLat - lastLat) > tolerance) {
                                            // Контур не замкнут - добавляем координаты начала и конца
                                            const transformedFirst = transformToWGS84([firstLon, firstLat]);
                                            const transformedLast = transformToWGS84([lastLon, lastLat]);
                                            
                                            if (ringIndex === 0) {
                                                errorCoordinates.push(transformedFirst);
                                                errors.push(`Начало внешнего контура: [${transformedFirst[0].toFixed(6)}, ${transformedFirst[1].toFixed(6)}]`);
                                            } else {
                                                errorCoordinates.push(transformedFirst);
                                                errors.push(`Начало внутреннего контура ${ringIndex}: [${transformedFirst[0].toFixed(6)}, ${transformedFirst[1].toFixed(6)}]`);
                                            }
                                            
                                            errorCoordinates.push(transformedLast);
                                            errors.push(`Конец контура: [${transformedLast[0].toFixed(6)}, ${transformedLast[1].toFixed(6)}]`);
                                        }
                                    }
                                }
                            });
                        } else if (geomGeoJSON.type === 'MultiPolygon' && geomGeoJSON.coordinates) {
                            // Для MultiPolygon проверяем каждый полигон
                            geomGeoJSON.coordinates.forEach((polygon, polyIndex) => {
                                if (polygon && polygon.length > 0) {
                                    polygon.forEach((ring, ringIndex) => {
                                        if (ring && ring.length > 0) {
                                            const first = ring[0];
                                            const last = ring[ring.length - 1];
                                            
                                            if (first && last && first.length >= 2 && last.length >= 2) {
                                                const firstLon = first[0];
                                                const firstLat = first[1];
                                                const lastLon = last[0];
                                                const lastLat = last[1];
                                                
                                                const tolerance = 0.000001;
                                                if (Math.abs(firstLon - lastLon) > tolerance || Math.abs(firstLat - lastLat) > tolerance) {
                                                    const transformedFirst = transformToWGS84([firstLon, firstLat]);
                                                    const transformedLast = transformToWGS84([lastLon, lastLat]);
                                                    
                                                    errorCoordinates.push(transformedFirst);
                                                    errors.push(`Полигон ${polyIndex + 1}, начало контура ${ringIndex === 0 ? 'внешнего' : ringIndex}: [${transformedFirst[0].toFixed(6)}, ${transformedFirst[1].toFixed(6)}]`);
                                                    
                                                    errorCoordinates.push(transformedLast);
                                                    errors.push(`Полигон ${polyIndex + 1}, конец контура: [${transformedLast[0].toFixed(6)}, ${transformedLast[1].toFixed(6)}]`);
                                                }
                                            }
                                        }
                                    });
                                }
                            });
                        }
                    } catch (e) {
                        console.error('Error finding unclosed ring coordinates:', e);
                    }
                    
                    return {
                        isValid: false,
                        errors: errors,
                        errorCoordinates: errorCoordinates
                    };
                }
                
                // Для других ошибок продолжаем к fallback методам
            }
        }
        
        // Fallback: используем OpenLayers для базовой проверки, если JSTS недоступен
        try {
            const format = new ol.format.GeoJSON();
            const olGeom = format.readGeometry(geomGeoJSON);
            const geomType = olGeom.getType();
            const errors = [];
            
            // Дополнительная проверка для полигонов
            if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
                const coords = olGeom.getCoordinates();
                if (!coords || coords.length === 0) {
                    errors.push('Полигон не содержит координат');
                    return { isValid: false, errors: errors, errorCoordinates: [] };
                }
                if (geomType === 'Polygon' && coords[0] && coords[0].length < 4) {
                    errors.push('Внешний контур полигона должен содержать минимум 4 точки');
                    return { isValid: false, errors: errors, errorCoordinates: [] };
                }
            }
            
            return { isValid: true, errors: [], errorCoordinates: [] };
        } catch (olError) {
            return { isValid: false, errors: ['Ошибка при чтении геометрии: ' + olError.message], errorCoordinates: [] };
        }
    } catch (e) {
        console.error('Error validating geometry:', e);
        return { isValid: false, errors: ['Ошибка валидации: ' + e.message], errorCoordinates: [] };
    }
}

// Рекурсивный анализ геометрии
function analyzeGeometry(geom, index = 0, parentType = null) {
    const geomType = geom.getType();
    const geomGeoJSON = olGeometryToGeoJSON(geom);
    // Передаем исходную OpenLayers геометрию для получения правильных координат ошибок
    const validationResult = isValidGeometry(geomGeoJSON, geom);
    const isValid = validationResult.isValid;
    const validationErrors = validationResult.errors || [];
    const errorCoordinates = validationResult.errorCoordinates || []; // Координаты ошибок
    
    let result = {
        index: index,
        type: geomType,
        parentType: parentType,
        isValid: isValid,
        validationErrors: validationErrors,
        errorCoordinates: errorCoordinates, // Сохраняем координаты ошибок
        details: {},
        geometry: geom // Сохраняем ссылку на саму геометрию
    };
    
    switch (geomType) {
        case 'Point':
            result.details = {
                points: 1
            };
            break;
            
        case 'MultiPoint':
            const mpCoords = geom.getCoordinates();
            result.details = {
                points: mpCoords.length
            };
            // Рекурсивно анализируем каждую точку
            result.children = [];
            for (let i = 0; i < mpCoords.length; i++) {
                const pt = new ol.geom.Point(mpCoords[i]);
                const ptAnalysis = analyzeGeometry(pt, i, geomType);
                result.children.push(ptAnalysis);
            }
            break;
            
        case 'LineString':
            const lsCoords = geom.getCoordinates();
            result.details = {
                points: lsCoords.length
            };
            break;
            
        case 'MultiLineString':
            const mlsCoords = geom.getCoordinates();
            let totalPoints = 0;
            result.children = [];
            for (let i = 0; i < mlsCoords.length; i++) {
                const line = new ol.geom.LineString(mlsCoords[i]);
                const lineAnalysis = analyzeGeometry(line, i, geomType);
                result.children.push(lineAnalysis);
                totalPoints += lineAnalysis.details.points;
            }
            result.details = {
                lines: mlsCoords.length,
                points: totalPoints
            };
            break;
            
        case 'Polygon':
            const polyCoords = geom.getCoordinates();
            let polyTotalPoints = 0;
            result.children = [];
            for (let i = 0; i < polyCoords.length; i++) {
                const ring = polyCoords[i];
                polyTotalPoints += ring.length;
                
                // Проверяем валидность контура
                // Создаем LineString из контура для проверки
                let ringIsValid = null;
                let ringValidationErrors = [];
                try {
                    const ringLineString = new ol.geom.LineString(ring);
                    const ringGeoJSON = olGeometryToGeoJSON(ringLineString);
                    const ringValidationResult = isValidGeometry(ringGeoJSON);
                    ringIsValid = ringValidationResult.isValid;
                    ringValidationErrors = ringValidationResult.errors || [];
                    
                    // Дополнительная проверка: контур должен быть замкнут (первая и последняя точки совпадают)
                    if (ring.length >= 4) {
                        const first = ring[0];
                        const last = ring[ring.length - 1];
                        if (first[0] !== last[0] || first[1] !== last[1]) {
                            ringIsValid = false;
                            ringValidationErrors.push('Контур не замкнут: первая и последняя точки не совпадают');
                        }
                    } else {
                        ringIsValid = false; // Контур должен иметь минимум 4 точки
                        ringValidationErrors.push('Контур должен содержать минимум 4 точки');
                    }
                } catch (e) {
                    ringIsValid = false;
                    ringValidationErrors.push('Ошибка при проверке контура: ' + e.message);
                }
                
                // Создаем LineString для контура (для подсветки)
                const ringLineString = new ol.geom.LineString(ring);
                
                result.children.push({
                    index: i,
                    type: i === 0 ? 'Exterior Ring' : 'Interior Ring',
                    parentType: geomType,
                    isValid: ringIsValid,
                    validationErrors: ringValidationErrors,
                    details: {
                        points: ring.length
                    },
                    geometry: ringLineString // Сохраняем геометрию контура
                });
            }
            result.details = {
                rings: polyCoords.length,
                points: polyTotalPoints
            };
            break;
            
        case 'MultiPolygon':
            const mpolyCoords = geom.getCoordinates();
            let mpolyTotalPoints = 0;
            let mpolyTotalRings = 0;
            result.children = [];
            for (let i = 0; i < mpolyCoords.length; i++) {
                const polygon = new ol.geom.Polygon(mpolyCoords[i]);
                const polyAnalysis = analyzeGeometry(polygon, i, geomType);
                result.children.push(polyAnalysis);
                mpolyTotalPoints += polyAnalysis.details.points;
                mpolyTotalRings += polyAnalysis.details.rings;
            }
            result.details = {
                polygons: mpolyCoords.length,
                rings: mpolyTotalRings,
                points: mpolyTotalPoints
            };
            break;
            
        case 'GeometryCollection':
            const gcGeoms = geom.getGeometries();
            result.children = [];
            for (let i = 0; i < gcGeoms.length; i++) {
                result.children.push(analyzeGeometry(gcGeoms[i], i, geomType));
            }
            result.details = {
                geometries: gcGeoms.length
            };
            break;
    }
    
    return result;
}

// Функция для отображения информации о геометриях
function renderGeometryInfo(analyses) {
    let html = '<div class="geometry-info-header">Информация о геометриях</div>';
    html += '<button id="simplify-geometries-btn" class="simplify-btn" style="width: 100%; margin-bottom: 8px; padding: 6px; background: #4f9fd3; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: 600;">Упростить геометрии</button>';
    html += '<div class="geometry-info-content">';
    
    if (analyses.length === 0) {
        html += '<div class="geometry-item">Геометрии не найдены</div>';
    } else {
        analyses.forEach((analysis, idx) => {
            html += renderGeometryItem(analysis, idx, 0, idx, null);
        });
    }
    
    html += '</div>';
    return html;
}

// Рекурсивная функция для отображения элемента геометрии
function renderGeometryItem(analysis, idx, level, featureIndex = null, childPath = null) {
    const indent = level * 20;
    const marginLeft = indent + 'px';
    
    // Определяем, нужно ли добавлять data-атрибуты для hover-эффекта
    // Добавляем для корневых элементов и для дочерних элементов мультигеометрий
    let dataAttr = '';
    let cursorStyle = '';
    
    if (featureIndex !== null) {
        if (level === 0) {
            // Корневой элемент - используем только featureIndex
            dataAttr = `data-feature-index="${featureIndex}"`;
            cursorStyle = 'cursor: pointer;';
        } else if (level > 0 && analysis.geometry && childPath !== null) {
            // Дочерний элемент - используем featureIndex и путь к дочернему элементу
            // childPath - это массив индексов, указывающий путь к дочернему элементу
            const pathStr = childPath.join(',');
            dataAttr = `data-feature-index="${featureIndex}" data-child-path="${pathStr}"`;
            cursorStyle = 'cursor: pointer;';
        }
    }
    
    let html = `<div class="geometry-item" style="margin-left: ${marginLeft}; ${cursorStyle}" ${dataAttr}>`;
    
    // Тип геометрии
    let typeLabel = analysis.type;
    if (analysis.parentType) {
        typeLabel += ` (в ${analysis.parentType})`;
    }
    html += `<div class="geometry-type"><strong>${typeLabel}</strong></div>`;
    
    // Детали
    html += '<div class="geometry-details">';
    if (analysis.details) {
        let hasDetails = false;
        if (analysis.details.points !== undefined) {
            html += `<span class="detail-item">Точек: ${analysis.details.points}</span>`;
            hasDetails = true;
        }
        if (analysis.details.lines !== undefined) {
            html += `<span class="detail-item">Линий: ${analysis.details.lines}</span>`;
            hasDetails = true;
        }
        if (analysis.details.rings !== undefined) {
            html += `<span class="detail-item">Контуров: ${analysis.details.rings}</span>`;
            hasDetails = true;
        }
        if (analysis.details.polygons !== undefined) {
            html += `<span class="detail-item">Полигонов: ${analysis.details.polygons}</span>`;
            hasDetails = true;
        }
        if (analysis.details.geometries !== undefined) {
            html += `<span class="detail-item">Геометрий: ${analysis.details.geometries}</span>`;
            hasDetails = true;
        }
        if (!hasDetails) {
            html += '<span class="detail-item">Нет деталей</span>';
        }
    } else {
        html += '<span class="detail-item">Детали недоступны</span>';
    }
    html += '</div>';
    
    // Валидность (не показываем для контуров)
    const isRing = analysis.type === 'Exterior Ring' || analysis.type === 'Interior Ring';
    if (!isRing) {
        html += '<div class="geometry-validity">';
        if (analysis.isValid === null) {
            html += '<span class="validity-unknown">Валидность: не проверена (JSTS не загружен)</span>';
        } else if (analysis.isValid) {
            html += '<span class="validity-valid">✓ Валидна</span>';
        } else {
            html += '<span class="validity-invalid">✗ Невалидна</span>';
        }
        html += '</div>';
        
        // Отображаем детали ошибок валидации, если они есть и валидация была выполнена
        if (analysis.isValid !== null && analysis.validationErrors && analysis.validationErrors.length > 0) {
            html += '<div class="validation-errors">';
            html += '<div class="validation-errors-title">Проблемы валидности:</div>';
            html += '<ul class="validation-errors-list">';
            analysis.validationErrors.forEach((error, idx) => {
                // Проверяем, есть ли координаты для этой ошибки
                const hasCoordinates = analysis.errorCoordinates && analysis.errorCoordinates.length > idx;
                const coordClass = hasCoordinates ? 'validation-error-item clickable-error' : 'validation-error-item';
                let clickHandler = '';
                if (hasCoordinates) {
                    const childPathStr = childPath ? JSON.stringify(childPath) : 'null';
                    clickHandler = `onclick="window.zoomToValidationError(${featureIndex}, ${childPathStr}, ${idx})"`;
                }
                
                // Формируем текст ошибки с координатами
                let errorText = DOMPurify.sanitize(error);
                
                // Если есть координаты и они еще не включены в текст ошибки, добавляем их явно
                if (hasCoordinates) {
                    const errorCoord = analysis.errorCoordinates[idx];
                    if (errorCoord && Array.isArray(errorCoord) && errorCoord.length >= 2) {
                        // GeoJSON использует формат [longitude, latitude]
                        const lon = errorCoord[0];
                        const lat = errorCoord[1];
                        
                        // Проверяем, не включены ли координаты уже в текст ошибки
                        const coordPattern = /\[[\d\.\-]+,\s*[\d\.\-]+\]/;
                        if (!coordPattern.test(errorText)) {
                            // Добавляем координаты в формате [lon, lat] с явным указанием порядка
                            errorText += ` <span class="error-coordinates" title="Координаты в формате GeoJSON [longitude, latitude]">[${lon.toFixed(6)}, ${lat.toFixed(6)}]</span>`;
                        } else {
                            // Если координаты уже есть в тексте, добавляем их еще раз с меткой для ясности
                            errorText += ` <span class="error-coordinates" title="Координаты в формате GeoJSON [longitude, latitude]">(координаты: [${lon.toFixed(6)}, ${lat.toFixed(6)}])</span>`;
                        }
                    }
                }
                
                html += `<li class="${coordClass}" ${clickHandler} title="${hasCoordinates ? 'Кликните для перехода к месту ошибки на карте' : ''}">${errorText}</li>`;
            });
            html += '</ul>';
            html += '</div>';
        }
    }
    
    html += '</div>';
    
    // Рекурсивно отображаем дочерние элементы
    if (analysis.children && analysis.children.length > 0) {
        analysis.children.forEach((child, childIdx) => {
            // Формируем путь к дочернему элементу
            const newChildPath = childPath === null ? [childIdx] : [...childPath, childIdx];
            html += renderGeometryItem(child, childIdx, level + 1, featureIndex, newChildPath);
        });
    }
    
    return html;
}


// Глобальные переменные для хранения связи между элементами меню и features
window.geometryInfoFeatures = null;
window.geometryInfoAnalyses = null; // Сохраняем анализы для доступа к дочерним геометриям
window.geometryInfoHighlightLayer = null;

// Функция для создания слоя подсветки bbox
function createHighlightLayer(map) {
    if (window.geometryInfoHighlightLayer) {
        map.removeLayer(window.geometryInfoHighlightLayer);
    }
    
    const highlightSource = new ol.source.Vector();
    const highlightLayer = new ol.layer.Vector({
        source: highlightSource,
        style: new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: '#ff0000',
                width: 3,
                lineDash: [5, 5]
            }),
            fill: new ol.style.Fill({
                color: 'rgba(255, 0, 0, 0.1)'
            })
        }),
        zIndex: 1000
    });
    
    map.addLayer(highlightLayer);
    window.geometryInfoHighlightLayer = highlightLayer;
    return highlightLayer;
}

// Функция для создания слоя маркеров ошибок валидации
function createValidationErrorsLayer(map) {
    if (window.validationErrorsLayer) {
        map.removeLayer(window.validationErrorsLayer);
    }
    
    const errorSource = new ol.source.Vector();
    const errorLayer = new ol.layer.Vector({
        source: errorSource,
        style: new ol.style.Style({
            image: new ol.style.Circle({
                radius: 8,
                stroke: new ol.style.Stroke({
                    color: '#ff0000',
                    width: 2
                }),
                fill: new ol.style.Fill({
                    color: 'rgba(255, 0, 0, 0.6)'
                })
            })
        }),
        zIndex: 1001 // Выше слоя подсветки
    });
    
    map.addLayer(errorLayer);
    window.validationErrorsLayer = errorLayer;
    return errorLayer;
}

// Функция для преобразования координат из EPSG:4326 в проекцию карты
function transformFromWGS84ToMap(coord, map) {
    if (!coord || !Array.isArray(coord) || coord.length < 2 || !map) {
        return coord;
    }
    
    try {
        const view = map.getView();
        if (!view) {
            return coord;
        }
        
        const mapProjection = view.getProjection();
        if (!mapProjection) {
            return coord;
        }
        
        const mapProjCode = mapProjection.getCode();
        
        // Если проекция карты уже EPSG:4326, возвращаем координаты как есть
        if (mapProjCode === 'EPSG:4326') {
            return coord;
        }
        
        // Преобразуем из EPSG:4326 в проекцию карты
        if (typeof ol !== 'undefined' && ol.proj && ol.proj.transform) {
            const transformed = ol.proj.transform([coord[0], coord[1]], 'EPSG:4326', mapProjCode);
            if (transformed && transformed.length >= 2) {
                return transformed;
            }
        }
        
        return coord;
    } catch (e) {
        console.error('Error transforming coordinates from EPSG:4326 to map projection:', e);
        return coord;
    }
}

// Функция для отображения маркеров ошибок на карте
function showValidationErrorMarkers(analyses) {
    if (!window.currentMap) {
        return;
    }
    
    // Создаем или получаем слой маркеров ошибок
    let errorLayer = window.validationErrorsLayer;
    if (!errorLayer) {
        errorLayer = createValidationErrorsLayer(window.currentMap);
    }
    
    const errorSource = errorLayer.getSource();
    errorSource.clear();
    
    // Собираем все координаты ошибок из всех анализов
    function collectErrorCoordinates(analysis) {
        const coords = [];
        
        // Добавляем координаты ошибок текущего анализа
        if (analysis.errorCoordinates && analysis.errorCoordinates.length > 0) {
            analysis.errorCoordinates.forEach(coord => {
                coords.push(coord);
            });
        }
        
        // Рекурсивно обрабатываем дочерние элементы
        if (analysis.children && analysis.children.length > 0) {
            analysis.children.forEach(child => {
                const childCoords = collectErrorCoordinates(child);
                coords.push(...childCoords);
            });
        }
        
        return coords;
    }
    
    // Собираем все координаты ошибок
    const allErrorCoords = [];
    analyses.forEach(analysis => {
        const coords = collectErrorCoordinates(analysis);
        allErrorCoords.push(...coords);
    });
    
    // Создаем features для каждой координаты ошибки
    // Координаты хранятся в EPSG:4326, преобразуем их в проекцию карты
    allErrorCoords.forEach(coord => {
        // Преобразуем координаты из EPSG:4326 в проекцию карты
        const mapCoord = transformFromWGS84ToMap(coord, window.currentMap);
        
        const point = new ol.geom.Point(mapCoord);
        const feature = new ol.Feature({
            geometry: point,
            name: 'Ошибка валидации'
        });
        errorSource.addFeature(feature);
    });
}

// Функция для получения геометрии по featureIndex и пути к дочернему элементу
function getGeometryByPath(featureIndex, childPath) {
    if (!window.geometryInfoAnalyses || !window.geometryInfoFeatures) {
        return null;
    }
    
    const analyses = window.geometryInfoAnalyses;
    if (featureIndex < 0 || featureIndex >= analyses.length) {
        return null;
    }
    
    const analysis = analyses[featureIndex];
    
    // Если путь не указан, возвращаем корневую геометрию
    if (!childPath || childPath.length === 0) {
        return analysis.geometry;
    }
    
    // Проходим по пути к дочернему элементу
    let current = analysis;
    for (let i = 0; i < childPath.length; i++) {
        const childIndex = childPath[i];
        if (!current.children || childIndex < 0 || childIndex >= current.children.length) {
            return null;
        }
        current = current.children[childIndex];
    }
    
    // Возвращаем геометрию дочернего элемента
    return current.geometry || null;
}

// Функция для вычисления расстояния между двумя координатами в метрах
function getDistance(coord1, coord2) {
    try {
        // Используем ol.sphere если доступен
        if (typeof ol !== 'undefined' && ol.sphere && ol.sphere.getDistance) {
            return ol.sphere.getDistance(coord1, coord2);
        }
        // Fallback: простое вычисление расстояния по формуле гаверсинуса
        const R = 6371000; // Радиус Земли в метрах
        const lat1 = coord1[1] * Math.PI / 180;
        const lat2 = coord2[1] * Math.PI / 180;
        const deltaLat = (coord2[1] - coord1[1]) * Math.PI / 180;
        const deltaLon = (coord2[0] - coord1[0]) * Math.PI / 180;
        
        const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                   Math.cos(lat1) * Math.cos(lat2) *
                   Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        
        return R * c;
    } catch (e) {
        // Если вычисление не удалось, возвращаем большое значение
        return Infinity;
    }
}

// Функция для поиска пути к дочернему элементу по координате курсора
function findChildPathByCoordinate(featureIndex, coordinate) {
    if (!window.geometryInfoAnalyses || !window.geometryInfoFeatures) {
        return null;
    }
    
    const analyses = window.geometryInfoAnalyses;
    if (featureIndex < 0 || featureIndex >= analyses.length) {
        return null;
    }
    
    const analysis = analyses[featureIndex];
    const rootGeometry = analysis.geometry;
    
    if (!rootGeometry) {
        return null;
    }
    
    const geomType = rootGeometry.getType();
    
    // Для мультигеометрий проверяем каждую дочернюю геометрию
    if (geomType === 'MultiPolygon' || geomType === 'MultiLineString' || geomType === 'MultiPoint' || geomType === 'GeometryCollection') {
        // Рекурсивно ищем дочерний элемент, содержащий координату
        function findPathRecursive(currentAnalysis, coord, currentPath) {
            if (!currentAnalysis.children || currentAnalysis.children.length === 0) {
                return null;
            }
            
            let bestMatch = null;
            let bestDistance = Infinity;
            
            for (let i = 0; i < currentAnalysis.children.length; i++) {
                const child = currentAnalysis.children[i];
                if (!child.geometry) {
                    continue;
                }
                
                const childGeom = child.geometry;
                const childType = childGeom.getType();
                
                // Проверяем, содержит ли дочерняя геометрия координату
                let contains = false;
                let distance = Infinity;
                
                try {
                    if (childType === 'Polygon') {
                        contains = childGeom.intersectsCoordinate(coord);
                        if (contains) {
                            distance = 0;
                        }
                    } else if (childType === 'LineString') {
                        // Для линий проверяем близость к линии
                        const closestPoint = childGeom.getClosestPoint(coord);
                        distance = getDistance(coord, closestPoint);
                        // Используем порог для определения близости (примерно 50 метров)
                        contains = distance < 50;
                    } else if (childType === 'Point') {
                        const pointCoord = childGeom.getCoordinates();
                        distance = getDistance(coord, pointCoord);
                        // Для точек используем меньший порог (примерно 20 метров)
                        contains = distance < 20;
                    } else {
                        // Для других типов используем intersectsCoordinate
                        contains = childGeom.intersectsCoordinate(coord);
                        if (contains) {
                            distance = 0;
                        }
                    }
                } catch (e) {
                    // Если проверка не удалась, пропускаем
                    continue;
                }
                
                if (contains && distance < bestDistance) {
                    bestDistance = distance;
                    const newPath = [...currentPath, i];
                    
                    // Если это не мультигеометрия, сохраняем путь
                    if (childType !== 'MultiPolygon' && childType !== 'MultiLineString' && childType !== 'MultiPoint' && childType !== 'GeometryCollection') {
                        bestMatch = newPath;
                    } else {
                        // Если это мультигеометрия, продолжаем поиск рекурсивно
                        const deeperPath = findPathRecursive(child, coord, newPath);
                        if (deeperPath) {
                            bestMatch = deeperPath;
                        } else {
                            bestMatch = newPath;
                        }
                    }
                }
            }
            
            return bestMatch;
        }
        
        return findPathRecursive(analysis, coordinate, []);
    }
    
    // Для обычных геометрий возвращаем null (нет дочерних элементов)
    return null;
}

// Функция для подсветки bbox геометрии
function highlightGeometryBbox(featureIndex, childPath = null) {
    if (!window.geometryInfoFeatures || !window.currentMap) {
        return;
    }
    
    // Получаем геометрию по пути
    const geometry = getGeometryByPath(featureIndex, childPath);
    if (!geometry) {
        return;
    }
    
    // Получаем или создаем слой подсветки
    let highlightLayer = window.geometryInfoHighlightLayer;
    if (!highlightLayer) {
        highlightLayer = createHighlightLayer(window.currentMap);
    }
    
    // Получаем bbox геометрии
    const extent = geometry.getExtent();
    if (!extent || extent.length !== 4) {
        return;
    }
    
    // Создаем полигон из bbox
    const bboxPolygon = ol.geom.Polygon.fromExtent(extent);
    const bboxFeature = new ol.Feature({
        geometry: bboxPolygon
    });
    
    // Очищаем предыдущую подсветку и добавляем новую
    const highlightSource = highlightLayer.getSource();
    highlightSource.clear();
    highlightSource.addFeature(bboxFeature);
}

// Функция для удаления подсветки
function clearGeometryHighlight() {
    if (window.geometryInfoHighlightLayer) {
        const highlightSource = window.geometryInfoHighlightLayer.getSource();
        if (highlightSource) {
            highlightSource.clear();
        }
    }
}

// Функция для перехода к месту ошибки валидации на карте
// Делаем её глобальной для доступа из HTML
window.zoomToValidationError = function(featureIndex, childPath, errorIndex) {
    if (!window.currentMap || !window.geometryInfoAnalyses) {
        return;
    }
    
    // Получаем анализ геометрии
    const analyses = window.geometryInfoAnalyses;
    if (featureIndex < 0 || featureIndex >= analyses.length) {
        return;
    }
    
    let analysis = analyses[featureIndex];
    
    // Если указан путь к дочернему элементу, проходим по нему
    if (childPath && childPath.length > 0) {
        for (let i = 0; i < childPath.length; i++) {
            const childIdx = childPath[i];
            if (analysis.children && childIdx < analysis.children.length) {
                analysis = analysis.children[childIdx];
            } else {
                return; // Неверный путь
            }
        }
    }
    
    // Получаем координаты ошибки
    if (!analysis.errorCoordinates || errorIndex >= analysis.errorCoordinates.length) {
        return;
    }
    
    const errorCoord = analysis.errorCoordinates[errorIndex];
    if (!errorCoord || errorCoord.length < 2) {
        return;
    }
    
    // Преобразуем координаты из EPSG:4326 в проекцию карты
    const mapCoord = transformFromWGS84ToMap(errorCoord, window.currentMap);
    
    // Переходим к координатам ошибки на карте
    const view = window.currentMap.getView();
    view.animate({
        center: mapCoord,
        zoom: Math.max(view.getZoom() || 10, 15), // Минимальный зум 15 для детального просмотра
        duration: 500
    });
    
    // Подсвечиваем точку ошибки
    if (window.validationErrorsLayer) {
        const errorSource = window.validationErrorsLayer.getSource();
        const features = errorSource.getFeatures();
        
        // Находим feature с нужными координатами (используем координаты в проекции карты)
        const errorFeature = features.find(f => {
            const geom = f.getGeometry();
            if (geom && geom.getType() === 'Point') {
                const coord = geom.getCoordinates();
                // Сравниваем координаты в проекции карты
                const tolerance = 0.01; // Толерантность зависит от проекции
                return Math.abs(coord[0] - mapCoord[0]) < tolerance && 
                       Math.abs(coord[1] - mapCoord[1]) < tolerance;
            }
            return false;
        });
        
        if (errorFeature) {
            // Временно увеличиваем маркер ошибки
            const originalStyle = window.validationErrorsLayer.getStyle();
            window.validationErrorsLayer.setStyle(function(feature, resolution) {
                if (feature === errorFeature) {
                    return new ol.style.Style({
                        image: new ol.style.Circle({
                            radius: 12,
                            stroke: new ol.style.Stroke({
                                color: '#ff0000',
                                width: 3
                            }),
                            fill: new ol.style.Fill({
                                color: 'rgba(255, 0, 0, 0.8)'
                            })
                        })
                    });
                }
                return originalStyle(feature, resolution);
            });
            
            // Возвращаем обычный стиль через 2 секунды
            setTimeout(() => {
                if (window.validationErrorsLayer) {
                    window.validationErrorsLayer.setStyle(originalStyle);
                }
            }, 2000);
        }
    }
}

// Флаг для отслеживания, находится ли мышь над меню
window.isMouseOverMenu = false;

// Функция для установки обработчиков событий на элементы меню
function setupGeometryInfoEventHandlers() {
    const infoDiv = document.getElementById('geometry-info');
    if (!infoDiv) {
        return;
    }
    
    // Устанавливаем обработчик на весь блок меню
    infoDiv.addEventListener('mouseenter', function() {
        window.isMouseOverMenu = true;
    });
    
    infoDiv.addEventListener('mouseleave', function() {
        window.isMouseOverMenu = false;
        // Убираем подсветку только если мышь не над картой
        setTimeout(function() {
            if (!window.isMouseOverMenu) {
                clearGeometryHighlight();
                // Убираем подсветку со всех элементов меню
                const allItems = infoDiv.querySelectorAll('.geometry-item[data-feature-index]');
                allItems.forEach(item => {
                    item.style.background = '#f9f9f9';
                });
            }
        }, 50);
    });
    
    // Удаляем старые обработчики
    const items = infoDiv.querySelectorAll('.geometry-item[data-feature-index]');
    items.forEach(item => {
        // Клонируем элемент для удаления всех обработчиков
        const newItem = item.cloneNode(true);
        item.parentNode.replaceChild(newItem, item);
    });
    
    // Добавляем новые обработчики для всех элементов с data-атрибутами
    const newItems = infoDiv.querySelectorAll('.geometry-item[data-feature-index]');
    newItems.forEach(item => {
        const featureIndex = parseInt(item.getAttribute('data-feature-index'));
        const childPathAttr = item.getAttribute('data-child-path');
        let childPath = null;
        
        // Парсим путь к дочернему элементу, если он есть
        if (childPathAttr) {
            childPath = childPathAttr.split(',').map(idx => parseInt(idx));
        }
        
        item.addEventListener('mouseenter', function() {
            window.isMouseOverMenu = true;
            highlightGeometryBbox(featureIndex, childPath);
            // Убираем подсветку со всех элементов меню
            const allItems = infoDiv.querySelectorAll('.geometry-item[data-feature-index]');
            allItems.forEach(otherItem => {
                otherItem.style.background = '#f9f9f9';
            });
            // Подсвечиваем текущий элемент
            item.style.background = '#e0f0ff';
        });
        
        item.addEventListener('mouseleave', function() {
            // Не убираем подсветку сразу, так как мышь может перейти на другой элемент меню
            // или на карту
        });
    });
}

// Функция для нормализации незамкнутых контуров в GeoJSON
function normalizeGeoJSONGeometries(geoJSON) {
    try {
        const parsed = JSON.parse(geoJSON);
        let modified = false;
        
        function closeRing(ring) {
            // Создаем копию массива
            const ringCopy = ring.map(coord => [coord[0], coord[1]]);
            
            if (ringCopy.length < 4) {
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
        
        function normalizeGeometry(geom) {
            if (!geom || !geom.type) {
                return { geom: geom, modified: false };
            }
            
            let localModified = false;
            let result = JSON.parse(JSON.stringify(geom)); // Глубокая копия
            
            switch (result.type) {
                case 'Polygon':
                    if (result.coordinates && Array.isArray(result.coordinates)) {
                        const closedRings = result.coordinates.map(ring => {
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
                    if (result.coordinates && Array.isArray(result.coordinates)) {
                        const closedPolygons = result.coordinates.map(polygon => {
                            return polygon.map(ring => {
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
                    if (result.geometry) {
                        const normalized = normalizeGeometry(result.geometry);
                        result.geometry = normalized.geom;
                        if (normalized.modified) {
                            localModified = true;
                        }
                    }
                    break;
                    
                case 'FeatureCollection':
                    if (result.features && Array.isArray(result.features)) {
                        result.features = result.features.map(feature => {
                            const normalized = normalizeGeometry(feature);
                            if (normalized.modified) {
                                localModified = true;
                            }
                            return normalized.geom;
                        });
                    }
                    break;
            }
            
            return { geom: result, modified: localModified };
        }
        
        const normalized = normalizeGeometry(parsed);
        
        if (normalized.modified) {
            modified = true;
        }
        
        if (modified) {
            return JSON.stringify(normalized.geom, null, 2);
        }
        
        return geoJSON;
    } catch (e) {
        console.error('Error normalizing GeoJSON:', e);
        return geoJSON;
    }
}

// Функция для упрощения геометрий с использованием TopologyPreservingSimplifier из JSTS
// Округляет координаты до тысячных и удаляет дублирующие точки
function simplifyGeoJSONGeometries(geoJSON) {
    try {
        // Проверяем доступность JSTS
        let jstsLib = null;
        if (typeof jsts !== 'undefined') {
            jstsLib = jsts;
        } else if (typeof window !== 'undefined' && window.jsts) {
            jstsLib = window.jsts;
        } else if (typeof self !== 'undefined' && self.jsts) {
            jstsLib = self.jsts;
        }
        
        if (!jstsLib || !jstsLib.io || !jstsLib.io.GeoJSONReader || !jstsLib.io.GeoJSONWriter || !jstsLib.simplify) {
            // Если JSTS недоступен, используем простое округление
            console.warn('JSTS недоступен, используется простое округление координат');
            return simplifyGeoJSONGeometriesFallback(geoJSON);
        }
        
        const parsed = JSON.parse(geoJSON);
        let modified = false;
        
        // Функция для округления координаты до тысячных
        function roundCoordinate(coord) {
            if (typeof coord === 'number') {
                return Math.round(coord * 1000) / 1000;
            }
            return coord;
        }
        
        // Функция для округления массива координат
        function roundCoordinates(coords) {
            if (!Array.isArray(coords)) {
                return coords;
            }
            
            // Если это массив координат [x, y] или [x, y, z]
            if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                return coords.map(roundCoordinate);
            }
            
            // Рекурсивно обрабатываем вложенные массивы
            return coords.map(roundCoordinates);
        }
        
        // Функция для упрощения геометрии через JSTS TopologyPreservingSimplifier
        function simplifyGeometryWithJSTS(geomGeoJSON) {
            try {
                const reader = new jstsLib.io.GeoJSONReader();
                const writer = new jstsLib.io.GeoJSONWriter();
                
                // Читаем геометрию из GeoJSON
                const jstsGeometry = reader.read(geomGeoJSON);
                if (!jstsGeometry) {
                    return { geom: geomGeoJSON, modified: false };
                }
                
                // Используем TopologyPreservingSimplifier
                // Толерантность расстояния: 0.001 (примерно соответствует тысячным)
                const TopologyPreservingSimplifier = jstsLib.simplify.TopologyPreservingSimplifier;
                if (!TopologyPreservingSimplifier) {
                    console.warn('TopologyPreservingSimplifier недоступен');
                    return { geom: geomGeoJSON, modified: false };
                }
                
                const simplifier = new TopologyPreservingSimplifier(jstsGeometry);
                // Устанавливаем толерантность расстояния (проверяем разные варианты названия метода)
                if (typeof simplifier.setDistanceTolerance === 'function') {
                    simplifier.setDistanceTolerance(0.001); // Толерантность в единицах координат
                } else if (typeof simplifier.setDistance === 'function') {
                    simplifier.setDistance(0.001);
                } else {
                    console.warn('Метод установки толерантности не найден в TopologyPreservingSimplifier');
                }
                const simplifiedGeometry = simplifier.getResultGeometry();
                
                if (!simplifiedGeometry) {
                    return { geom: geomGeoJSON, modified: false };
                }
                
                // Преобразуем обратно в GeoJSON
                const simplifiedGeoJSON = writer.write(simplifiedGeometry);
                
                if (!simplifiedGeoJSON) {
                    return { geom: geomGeoJSON, modified: false };
                }
                
                // Всегда округляем координаты до тысячных
                if (simplifiedGeoJSON.coordinates) {
                    simplifiedGeoJSON.coordinates = roundCoordinates(simplifiedGeoJSON.coordinates);
                }
                
                // Также округляем координаты в исходной геометрии для корректного сравнения
                const originalRounded = JSON.parse(JSON.stringify(geomGeoJSON));
                if (originalRounded.coordinates) {
                    originalRounded.coordinates = roundCoordinates(originalRounded.coordinates);
                }
                
                // Проверяем, были ли изменения, сравнивая нормализованные JSON
                const originalStr = JSON.stringify(originalRounded);
                const simplifiedStr = JSON.stringify(simplifiedGeoJSON);
                const wasModified = originalStr !== simplifiedStr;
                
                return { geom: simplifiedGeoJSON, modified: wasModified };
            } catch (e) {
                console.error('Error simplifying geometry with JSTS:', e);
                return { geom: geomGeoJSON, modified: false };
            }
        }
        
        // Рекурсивная функция для упрощения геометрии
        function simplifyGeometry(geom) {
            if (!geom || typeof geom !== 'object') {
                return { geom: geom, modified: false };
            }
            
            let localModified = false;
            const result = JSON.parse(JSON.stringify(geom)); // Глубокое копирование
            
            switch (result.type) {
                case 'Point':
                    // Для точек просто округляем координаты
                    if (result.coordinates && Array.isArray(result.coordinates)) {
                        const rounded = roundCoordinates(result.coordinates);
                        if (JSON.stringify(rounded) !== JSON.stringify(result.coordinates)) {
                            result.coordinates = rounded;
                            localModified = true;
                        }
                    }
                    break;
                    
                case 'LineString':
                case 'Polygon':
                case 'MultiPoint':
                case 'MultiLineString':
                case 'MultiPolygon':
                    // Для геометрий используем JSTS TopologyPreservingSimplifier
                    const simplified = simplifyGeometryWithJSTS(result);
                    if (simplified.modified) {
                        Object.assign(result, simplified.geom);
                        localModified = true;
                    }
                    break;
                    
                case 'Feature':
                    if (result.geometry) {
                        const simplified = simplifyGeometry(result.geometry);
                        result.geometry = simplified.geom;
                        if (simplified.modified) {
                            localModified = true;
                        }
                    }
                    break;
                    
                case 'FeatureCollection':
                    if (result.features && Array.isArray(result.features)) {
                        result.features = result.features.map(feature => {
                            const simplified = simplifyGeometry(feature);
                            if (simplified.modified) {
                                localModified = true;
                            }
                            return simplified.geom;
                        });
                    }
                    break;
            }
            
            return { geom: result, modified: localModified };
        }
        
        const simplified = simplifyGeometry(parsed);
        
        if (simplified.modified) {
            modified = true;
        }
        
        // Всегда применяем округление координат к финальному результату
        // Это гарантирует, что координаты будут округлены до тысячных
        const finalResult = simplified.geom;
        
        // Применяем округление ко всем координатам в результате
        function applyRoundingToGeometry(geom) {
            if (!geom || typeof geom !== 'object') {
                return;
            }
            
            if (geom.coordinates && Array.isArray(geom.coordinates)) {
                const rounded = roundCoordinates(geom.coordinates);
                if (JSON.stringify(rounded) !== JSON.stringify(geom.coordinates)) {
                    geom.coordinates = rounded;
                    modified = true;
                }
            }
            
            if (geom.geometry) {
                applyRoundingToGeometry(geom.geometry);
            }
            
            if (geom.features && Array.isArray(geom.features)) {
                geom.features.forEach(feature => {
                    applyRoundingToGeometry(feature);
                });
            }
        }
        
        // Применяем округление к финальному результату
        applyRoundingToGeometry(finalResult);
        
        // Всегда возвращаем результат с округленными координатами
        // Сравниваем нормализованные JSON (без форматирования) для определения изменений
        const originalNormalized = JSON.stringify(parsed);
        const finalNormalized = JSON.stringify(finalResult);
        
        // Если есть изменения (структурные или в координатах), возвращаем результат
        if (originalNormalized !== finalNormalized || modified) {
            return JSON.stringify(finalResult, null, 2);
        }
        
        // Даже если изменений нет, возвращаем результат с округленными координатами
        // Это гарантирует, что координаты всегда будут округлены до тысячных
        return JSON.stringify(finalResult, null, 2);
    } catch (e) {
        console.error('Error simplifying GeoJSON:', e);
        return geoJSON;
    }
}

// Fallback функция для упрощения без JSTS (простое округление)
function simplifyGeoJSONGeometriesFallback(geoJSON) {
    try {
        const parsed = JSON.parse(geoJSON);
        let modified = false;
        
        // Функция для округления координаты до тысячных
        function roundCoordinate(coord) {
            if (typeof coord === 'number') {
                return Math.round(coord * 1000) / 1000;
            }
            return coord;
        }
        
        // Функция для округления массива координат
        function roundCoordinates(coords) {
            if (!Array.isArray(coords)) {
                return coords;
            }
            
            if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                return coords.map(roundCoordinate);
            }
            
            return coords.map(roundCoordinates);
        }
        
        // Рекурсивная функция для упрощения геометрии
        function simplifyGeometry(geom) {
            if (!geom || typeof geom !== 'object') {
                return { geom: geom, modified: false };
            }
            
            let localModified = false;
            const result = JSON.parse(JSON.stringify(geom));
            
            switch (result.type) {
                case 'Point':
                case 'LineString':
                case 'Polygon':
                case 'MultiPoint':
                case 'MultiLineString':
                case 'MultiPolygon':
                    if (result.coordinates && Array.isArray(result.coordinates)) {
                        const rounded = roundCoordinates(result.coordinates);
                        if (JSON.stringify(rounded) !== JSON.stringify(result.coordinates)) {
                            result.coordinates = rounded;
                            localModified = true;
                        }
                    }
                    break;
                    
                case 'Feature':
                    if (result.geometry) {
                        const simplified = simplifyGeometry(result.geometry);
                        result.geometry = simplified.geom;
                        if (simplified.modified) {
                            localModified = true;
                        }
                    }
                    break;
                    
                case 'FeatureCollection':
                    if (result.features && Array.isArray(result.features)) {
                        result.features = result.features.map(feature => {
                            const simplified = simplifyGeometry(feature);
                            if (simplified.modified) {
                                localModified = true;
                            }
                            return simplified.geom;
                        });
                    }
                    break;
            }
            
            return { geom: result, modified: localModified };
        }
        
        const simplified = simplifyGeometry(parsed);
        
        if (simplified.modified) {
            modified = true;
        }
        
        if (modified) {
            return JSON.stringify(simplified.geom, null, 2);
        }
        
        return geoJSON;
    } catch (e) {
        console.error('Error in fallback simplification:', e);
        return geoJSON;
    }
}

// Функция для анализа всех features и обновления панели информации
function updateGeometryInfo(source) {
    // Используем исходный порядок features, если он сохранен, иначе используем getFeatures()
    const features = source.originalFeatures || source.getFeatures();
    const analyses = [];
    
    // Сохраняем ссылку на features для использования в обработчиках
    window.geometryInfoFeatures = features;
    
    features.forEach((feature, idx) => {
        const geom = feature.getGeometry();
        if (geom) {
            analyses.push(analyzeGeometry(geom, idx));
        }
    });
    
    // Сохраняем анализы для доступа к дочерним геометриям
    window.geometryInfoAnalyses = analyses;
    
    // Отображаем маркеры ошибок на карте
    showValidationErrorMarkers(analyses);
    
    const infoDiv = document.getElementById('geometry-info');
    if (infoDiv) {
        infoDiv.innerHTML = renderGeometryInfo(analyses);
        
        // Устанавливаем обработчики событий после обновления HTML
        setTimeout(function() {
            setupGeometryInfoEventHandlers();
            setupSimplifyButtonHandler();
        }, 10);
    }
}

// Функция для установки обработчика кнопки упрощения геометрий
function setupSimplifyButtonHandler() {
    const btn = document.getElementById('simplify-geometries-btn');
    if (btn) {
        // Удаляем старый обработчик, если есть
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        // Добавляем новый обработчик
        newBtn.addEventListener('click', function() {
            // Функция для получения VS Code API с ожиданием
            function waitForVSCodeAPI(maxAttempts = 50, delay = 50) {
                return new Promise((resolve, reject) => {
                    let attempts = 0;
                    function check() {
                        if (window.vscode) {
                            resolve(window.vscode);
                        } else if (attempts < maxAttempts) {
                            attempts++;
                            setTimeout(check, delay);
                        } else {
                            reject(new Error('VS Code API не доступен. Попробуйте обновить предпросмотр.'));
                        }
                    }
                    check();
                });
            }
            
            // Ждем доступности VS Code API
            waitForVSCodeAPI()
                .then(vscode => {
                    // Проверяем доступность currentDocUri
                    if (typeof currentDocUri === 'undefined') {
                        vscode.postMessage({
                            command: 'error',
                            message: 'Не удалось определить URI документа'
                        });
                        return;
                    }
                    
                    // Получаем исходный контент документа
                    const docUri = currentDocUri;
                    newBtn.disabled = true;
                    newBtn.textContent = 'Обработка...';
                    
                    return fetch(docUri + (docUri.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now(), { cache: 'no-cache' })
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
                            // Сравниваем нормализованные JSON (без учета форматирования)
                            try {
                                const originalParsed = JSON.parse(content);
                                const simplifiedParsed = JSON.parse(simplified);
                                const originalNormalized = JSON.stringify(originalParsed);
                                const simplifiedNormalized = JSON.stringify(simplifiedParsed);
                                
                                if (originalNormalized === simplifiedNormalized) {
                                    vscode.postMessage({
                                        command: 'info',
                                        message: 'Геометрии уже упрощены или не требуют упрощения'
                                    });
                                } else {
                                    // Отправляем упрощенный контент в расширение
                                    vscode.postMessage({
                                        command: 'simplifyGeometries',
                                        content: simplified
                                    });
                                }
                            } catch (e) {
                                // Если не удалось распарсить, отправляем результат в любом случае
                                console.error('Error comparing simplified result:', e);
                                vscode.postMessage({
                                    command: 'simplifyGeometries',
                                    content: simplified
                                });
                            }
                        });
                })
                .catch(e => {
                    console.error('Error:', e);
                    // Пытаемся отправить сообщение об ошибке, если API доступен
                    if (window.vscode) {
                        window.vscode.postMessage({
                            command: 'error',
                            message: 'Ошибка при упрощении геометрий: ' + e.message
                        });
                    }
                })
                .finally(() => {
                    // Восстанавливаем кнопку
                    newBtn.disabled = false;
                    newBtn.textContent = 'Упростить геометрии';
                });
        });
    }
}

// Функция для установки обработчика кнопки нормализации
function setupNormalizeButtonHandler() {
    const btn = document.getElementById('normalize-geometries-btn');
    if (btn) {
        // Удаляем старый обработчик, если есть
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        // Добавляем новый обработчик
        newBtn.addEventListener('click', function() {
            // Функция для получения VS Code API с ожиданием
            function waitForVSCodeAPI(maxAttempts = 50, delay = 50) {
                return new Promise((resolve, reject) => {
                    let attempts = 0;
                    function check() {
                        if (window.vscode) {
                            resolve(window.vscode);
                        } else if (attempts < maxAttempts) {
                            attempts++;
                            setTimeout(check, delay);
                        } else {
                            reject(new Error('VS Code API не доступен. Попробуйте обновить предпросмотр.'));
                        }
                    }
                    check();
                });
            }
            
            // Ждем доступности VS Code API
            waitForVSCodeAPI()
                .then(vscode => {
                    // Проверяем доступность currentDocUri
                    if (typeof currentDocUri === 'undefined') {
                        vscode.postMessage({
                            command: 'error',
                            message: 'Не удалось определить URI документа'
                        });
                        return;
                    }
                    
                    // Получаем исходный контент документа
                    const docUri = currentDocUri;
                    newBtn.disabled = true;
                    newBtn.textContent = 'Обработка...';
                    
                    return fetch(docUri + (docUri.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now(), { cache: 'no-cache' })
                        .then(r => {
                            if (!r.ok) {
                                throw new Error('HTTP error! status: ' + r.status);
                            }
                            return r.text();
                        })
                        .then(content => {
                            // Нормализуем GeoJSON
                            const normalized = normalizeGeoJSONGeometries(content);
                            
                            // Проверяем, были ли внесены изменения
                            if (normalized === content) {
                                vscode.postMessage({
                                    command: 'info',
                                    message: 'Незамкнутые контуры не найдены'
                                });
                            } else {
                                // Отправляем нормализованный контент в расширение
                                vscode.postMessage({
                                    command: 'normalizeGeometries',
                                    content: normalized
                                });
                            }
                        });
                })
                .catch(e => {
                    console.error('Error:', e);
                    // Пытаемся отправить сообщение об ошибке, если API доступен
                    if (window.vscode) {
                        window.vscode.postMessage({
                            command: 'error',
                            message: 'Ошибка: ' + e.message
                        });
                    } else {
                        alert('Ошибка: ' + e.message);
                    }
                })
                .finally(() => {
                    newBtn.disabled = false;
                    newBtn.textContent = 'Исправить незамкнутые контуры';
                });
        });
    }
}

function initPreviewMap(domElId, preview, previewSettings) {
    let vertexStyle = null;
    if (previewSettings.style.vertex.enabled === true) {
        vertexStyle = new ol.style.Style({
            image: vertexImage(previewSettings.style.vertex.fill.color, previewSettings),
            geometry: function (feature) {
                let g = feature.getGeometry();
                let gt = g.getType();
                switch (gt) {
                    case "MultiPolygon":
                        {
                            let coords = g.getCoordinates();
                            let geoms = [];
                            for (let i = 0; i < coords.length; i++) {
                                let polyCoords = coords[i];
                                for (let j = 0; j < polyCoords.length; j++) {
                                    let pts = polyCoords[j];
                                    geoms.push(new ol.geom.MultiPoint(pts));
                                }
                            }
                            return new ol.geom.GeometryCollection(geoms);
                        }
                    case "MultiLineString":
                    case "Polygon":
                        {
                            let coords = g.getCoordinates();
                            let geoms = [];
                            for (let i = 0; i < coords.length; i++) {
                                let pts = coords[i];
                                geoms.push(new ol.geom.MultiPoint(pts));
                            }
                            return new ol.geom.GeometryCollection(geoms);
                        }
                    case "LineString":
                        {
                            let coords = g.getCoordinates();
                            let geoms = [];
                            for (let i = 0; i < coords.length; i++) {
                                let pts = coords[i];
                                geoms.push(new ol.geom.Point(pts));
                            }
                            return new ol.geom.GeometryCollection(geoms);
                        }
                }
                return g;
            }
        });
    }
    let polygonStyle = [new ol.style.Style({
        stroke: new ol.style.Stroke(previewSettings.style.polygon.stroke),
        fill: new ol.style.Fill(previewSettings.style.polygon.fill)
    })];
    if (vertexStyle) {
        polygonStyle.push(vertexStyle);
    }
    let lineStyle = [new ol.style.Style({
        fill: new ol.style.Stroke({
            color: previewSettings.style.line.stroke.color
        }),
        stroke: new ol.style.Stroke(previewSettings.style.line.stroke)
    })];
    if (vertexStyle) {
        lineStyle.push(vertexStyle);
    }
    let pointStyle = new ol.style.Style({
        image: pointImage(previewSettings.style.point.stroke.color, previewSettings)
    });
    let previewLayer = new ol.layer.Vector({
        source: preview.source,
        //NOTE: Has no effect for KML, which is fine because it has its own style def that OL
        //wisely steps aside
        style: function (feature, resolution) {
            let geom = feature.getGeometry();
            if (geom) {
                let geomType = geom.getType();
                if (geomType.indexOf("Polygon") >= 0) {
                    return polygonWithSimpleStyle(polygonStyle, feature, previewSettings);
                } else if (geomType.indexOf("Line") >= 0) {
                    return lineWithSimpleStyle(lineStyle, feature, previewSettings);
                } else if (geomType.indexOf("Point") >= 0) {
                    return pointWithSimpleStyle(pointStyle, feature, previewSettings);
                } else { //GeometryCollection
                    return [pointStyle, lineStyle, polygonStyle];
                }
            }
            return null;
        },
        declutter: previewSettings.declutterLabels
    });
    setupLayers(previewSettings).then((baseLayers) => {
        loadingDone();
        let map = new ol.Map({
            target: 'map',
            controls: ol.control.defaults.defaults({
                attributionOptions: {
                    collapsible: true
                }
            }).extend([
                new ol.control.ScaleLine(),
                new ol.control.MousePosition({
                    projection: (previewSettings.coordinateDisplay.projection || 'EPSG:4326'),
                    coordinateFormat: function (coordinate) {
                        return ol.coordinate.format(coordinate, (previewSettings.coordinateDisplay.format || 'Lat: {y}, Lng: {x}'), 4);
                    }
                }),
                new ol.control.ZoomSlider(),
                new ol.control.ZoomToExtent()
            ]),
            layers: [
                new ol.layer.Group({
                    title: "Base Maps",
                    layers: baseLayers
                }),
                new ol.layer.Group({
                    title: "Map Preview",
                    layers: [
                        previewLayer
                    ]
                })
            ]
        });
        let mapView = new ol.View();
        mapView.fit(preview.source.getExtent(), map.getSize());
        map.setView(mapView);
        let popup = new Popup();
        map.addOverlay(popup);
        let layerSwitcher = new ol.control.LayerSwitcher({
            tipLabel: 'Legend' // Optional label for button
        });
        map.addControl(layerSwitcher);
    
        let select = makeSelectInteraction(previewSettings);
        map.addInteraction(select);
    
        select.on('select', function (evt) {
            let selFeatures = evt.selected;
            let html = renderFeaturesHtml(selFeatures);
            if (html)
                popup.show(evt.mapBrowserEvent.coordinate, html);
        });
        
        // Создаем слой подсветки при инициализации карты
        createHighlightLayer(map);
        
        // Добавляем обработчик для подсветки элементов меню при наведении на карту
        let hoverInteraction = new ol.interaction.Select({
            condition: ol.events.condition.pointerMove,
            style: function() {
                // Возвращаем null, чтобы не изменять стиль самих features
                return null;
            }
        });
        
        hoverInteraction.on('select', function(evt) {
            // Игнорируем события, если мышь над меню
            if (window.isMouseOverMenu) {
                return;
            }
            
            const selectedFeatures = evt.selected;
            const infoDiv = document.getElementById('geometry-info');
            
            if (!infoDiv || !window.geometryInfoFeatures) {
                return;
            }
            
            // Убираем подсветку со всех элементов меню
            const allItems = infoDiv.querySelectorAll('.geometry-item[data-feature-index]');
            allItems.forEach(item => {
                item.style.background = '#f9f9f9';
            });
            
            // Подсвечиваем соответствующий элемент меню
            if (selectedFeatures.getLength() > 0) {
                const hoveredFeature = selectedFeatures.item(0);
                const featureIndex = window.geometryInfoFeatures.indexOf(hoveredFeature);
                
                if (featureIndex >= 0) {
                    // Пытаемся найти дочерний элемент, над которым находится курсор
                    const coordinate = evt.mapBrowserEvent.coordinate;
                    const childPath = findChildPathByCoordinate(featureIndex, coordinate);
                    
                    // Формируем селектор для поиска элемента меню
                    let menuItemSelector = `.geometry-item[data-feature-index="${featureIndex}"]`;
                    if (childPath && childPath.length > 0) {
                        // Ищем элемент с соответствующим путем к дочернему элементу
                        const pathStr = childPath.join(',');
                        menuItemSelector = `.geometry-item[data-feature-index="${featureIndex}"][data-child-path="${pathStr}"]`;
                    }
                    
                    const menuItem = infoDiv.querySelector(menuItemSelector);
                    if (menuItem) {
                        menuItem.style.background = '#e0f0ff';
                        // Прокручиваем к элементу, если он не виден
                        menuItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    } else if (!childPath || childPath.length === 0) {
                        // Если не нашли дочерний элемент, ищем корневой
                        const rootMenuItem = infoDiv.querySelector(`.geometry-item[data-feature-index="${featureIndex}"]:not([data-child-path])`);
                        if (rootMenuItem) {
                            rootMenuItem.style.background = '#e0f0ff';
                            rootMenuItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                    }
                    
                    // Подсвечиваем bbox на карте (с учетом дочернего элемента, если есть)
                    highlightGeometryBbox(featureIndex, childPath);
                }
            } else {
                // Если курсор не над геометрией, убираем подсветку
                clearGeometryHighlight();
            }
        });
        
        map.addInteraction(hoverInteraction);
        
        // Обновляем информацию о геометриях после инициализации карты
        setTimeout(function() {
            if (typeof updateGeometryInfo === 'function') {
                updateGeometryInfo(preview.source);
            }
        }, 200);
        
        // Сохраняем карту в глобальной переменной для доступа извне
        window.currentMap = map;
    }).catch(e => {
        loadingDone();
    });
}