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
                features = tryReadFeatures(driver, contentToParse, formatOptions);
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
        callback({
            source: new ol.source.Vector({
                features: features,
                //This is needed for features that cross the intl date line to display properly since we aren't fixing our viewport to one
                //particular view of the world and OL wraps to one earth's flattened viewport.
                wrapX: false
            }),
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

// Функция для проверки валидности геометрии через turf.js v7.3
function isValidGeometry(geomGeoJSON) {
    try {
        // Проверяем разные варианты доступа к turf.js
        let turfLib = null;
        if (typeof turf !== 'undefined') {
            turfLib = turf;
        } else if (typeof window !== 'undefined' && window.turf) {
            turfLib = window.turf;
        } else if (typeof self !== 'undefined' && self.turf) {
            turfLib = self.turf;
        }
        
        if (!turfLib) {
            return null; // turf не загружен
        }
        
        // В turf.js v7.3 функция booleanValid должна быть доступна
        let booleanValidFunc = null;
        
        // Вариант 1: turf.booleanValid
        if (turfLib.booleanValid && typeof turfLib.booleanValid === 'function') {
            booleanValidFunc = turfLib.booleanValid;
        }
        // Вариант 2: через default экспорт
        else if (turfLib.default && turfLib.default.booleanValid && typeof turfLib.default.booleanValid === 'function') {
            booleanValidFunc = turfLib.default.booleanValid;
        }
        
        if (booleanValidFunc) {
            try {
                // Преобразуем геометрию в Feature для turf.js
                let featureToValidate = geomGeoJSON;
                if (geomGeoJSON.type === 'Geometry') {
                    featureToValidate = {
                        type: 'Feature',
                        geometry: geomGeoJSON,
                        properties: {}
                    };
                }
                return booleanValidFunc(featureToValidate);
            } catch (e) {
                console.error('Error calling turf.booleanValid:', e);
                return false;
            }
        }
        
        // Если функция не найдена, используем OpenLayers как fallback
        try {
            const format = new ol.format.GeoJSON();
            const olGeom = format.readGeometry(geomGeoJSON);
            const geomType = olGeom.getType();
            
            // Дополнительная проверка для полигонов
            if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
                const coords = olGeom.getCoordinates();
                if (!coords || coords.length === 0) {
                    return false;
                }
                if (geomType === 'Polygon' && coords[0] && coords[0].length < 4) {
                    return false;
                }
            }
            return true;
        } catch (olError) {
            return false;
        }
    } catch (e) {
        console.error('Error validating geometry:', e);
        return false;
    }
}

// Рекурсивный анализ геометрии
function analyzeGeometry(geom, index = 0, parentType = null) {
    const geomType = geom.getType();
    const geomGeoJSON = olGeometryToGeoJSON(geom);
    const isValid = isValidGeometry(geomGeoJSON);
    
    let result = {
        index: index,
        type: geomType,
        parentType: parentType,
        isValid: isValid,
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
                try {
                    const ringLineString = new ol.geom.LineString(ring);
                    const ringGeoJSON = olGeometryToGeoJSON(ringLineString);
                    ringIsValid = isValidGeometry(ringGeoJSON);
                    
                    // Дополнительная проверка: контур должен быть замкнут (первая и последняя точки совпадают)
                    if (ring.length >= 4) {
                        const first = ring[0];
                        const last = ring[ring.length - 1];
                        if (first[0] !== last[0] || first[1] !== last[1]) {
                            ringIsValid = false;
                        }
                    } else {
                        ringIsValid = false; // Контур должен иметь минимум 4 точки
                    }
                } catch (e) {
                    ringIsValid = false;
                }
                
                // Создаем LineString для контура (для подсветки)
                const ringLineString = new ol.geom.LineString(ring);
                
                result.children.push({
                    index: i,
                    type: i === 0 ? 'Exterior Ring' : 'Interior Ring',
                    parentType: geomType,
                    isValid: ringIsValid,
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
    
    // Валидность
    html += '<div class="geometry-validity">';
    if (analysis.isValid === null) {
        html += '<span class="validity-unknown">Валидность: не проверена (turf.js не загружен)</span>';
    } else if (analysis.isValid) {
        html += '<span class="validity-valid">✓ Валидна</span>';
    } else {
        html += '<span class="validity-invalid">✗ Невалидна</span>';
    }
    html += '</div>';
    
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

// Функция для проверки доступности turf.js
function checkTurfAvailability() {
    const checks = {
        'typeof turf': typeof turf,
        'window.turf': typeof window !== 'undefined' ? typeof window.turf : 'N/A',
        'turf.booleanValid': typeof turf !== 'undefined' && typeof turf.booleanValid,
        'turf.default': typeof turf !== 'undefined' && turf.default ? typeof turf.default : 'N/A',
        'turf.valid': typeof turf !== 'undefined' && typeof turf.valid
    };
    console.log('Turf.js availability check:', checks);
    return checks;
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

// Функция для анализа всех features и обновления панели информации
function updateGeometryInfo(source) {
    const features = source.getFeatures();
    const analyses = [];
    
    // Сохраняем ссылку на features для использования в обработчиках
    window.geometryInfoFeatures = features;
    
    // Проверяем доступность turf.js при первом вызове
    if (typeof window.turfChecked === 'undefined') {
        checkTurfAvailability();
        window.turfChecked = true;
    }
    
    features.forEach((feature, idx) => {
        const geom = feature.getGeometry();
        if (geom) {
            analyses.push(analyzeGeometry(geom, idx));
        }
    });
    
    // Сохраняем анализы для доступа к дочерним геометриям
    window.geometryInfoAnalyses = analyses;
    
    const infoDiv = document.getElementById('geometry-info');
    if (infoDiv) {
        infoDiv.innerHTML = renderGeometryInfo(analyses);
        
        // Устанавливаем обработчики событий после обновления HTML
        setTimeout(function() {
            setupGeometryInfoEventHandlers();
        }, 10);
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