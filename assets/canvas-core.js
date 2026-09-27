/**
 *  Bitmap filter helpers
 */

Filters = {};

// Stage-sized mask canvases are allocated in pairs, every frame, by the
// clip export. Reuse them across frames. Checked-out canvases stay
// distinct until the next beginCanvasPool(), so a mask and its contents
// can both be live during one composite.
var _canvasPool = [];
var _canvasPoolUsed = 0;
var _poolW = 0;
var _poolH = 0;
var _cachedGameCanvas = null;
var beginCanvasPool = function () { _canvasPoolUsed = 0; };
var createCanvas = function (width, height) {
    if (!_cachedGameCanvas || !_cachedGameCanvas.isConnected) {
        _cachedGameCanvas = typeof document !== "undefined" ? document.getElementById("game") : null;
    }
    var game = _cachedGameCanvas;
    var stageSized = game && width === game.width && height === game.height && width > 0;
    // The fallback reset below clears pixels and a few properties, but cannot
    // reset the native save/clip stack. Only pool where the full Canvas reset
    // operation is available; otherwise return a fresh canvas as before.
    var canReset = typeof CanvasRenderingContext2D !== "undefined" &&
        typeof CanvasRenderingContext2D.prototype.reset === "function";
    // Stage-sized canvases are pooled instead of allocated per call: the
    // filter sprites (sprite318 et al.) build scratch copies of the whole
    // stage. Every scratch canvas is composited back to its target within
    // the same frame, and beginCanvasPool() restarts the cursor at each
    // render, so a pooled canvas is only reused on a later frame once its
    // contents are guaranteed to be stale.
    if (canReset && stageSized) {
        if (_poolW !== width || _poolH !== height) {
            _canvasPool = [];
            _canvasPoolUsed = 0;
            _poolW = width;
            _poolH = height;
        }
        var pooled = _canvasPool[_canvasPoolUsed];
        if (!pooled) {
            pooled = document.createElement("canvas");
            pooled.width = width;
            pooled.height = height;
            _canvasPool[_canvasPoolUsed] = pooled;
        } else {
            var g = pooled.getContext("2d");
            if (g.reset) g.reset();
            else {
                g.setTransform(1, 0, 0, 1, 0, 0);
                g.globalAlpha = 1;
                g.globalCompositeOperation = "source-over";
                g.clearRect(0, 0, width, height);
            }
            if (g._enhanced) {
                g._matrix = [1, 0, 0, 1, 0, 0];
                g._savedMatrices = [];
                g._clipBox = null;
                g._pathBox = null;
                g._cachedPath = null;
            }
        }
        _canvasPoolUsed++;
        return pooled;
    }
    var c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
};

Filters._premultiply = function (data) {
    var len = data.length;
    for (var i = 0; i < len; i += 4) {
        var f = data[i + 3] * 0.003921569;
        data[i] = Math.round(data[i] * f);
        data[i + 1] = Math.round(data[i + 1] * f);
        data[i + 2] = Math.round(data[i + 2] * f);
    }
};

Filters._unpremultiply = function (data) {
    var len = data.length;
    for (var i = 0; i < len; i += 4) {
        var a = data[i + 3];
        if (a == 0 || a == 255) {
            continue;
        }
        var f = 255 / a;
        var r = (data[i] * f);
        var g = (data[i + 1] * f);
        var b = (data[i + 2] * f);
        if (r > 255) {
            r = 255;
        }
        if (g > 255) {
            g = 255;
        }
        if (b > 255) {
            b = 255;
        }

        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
    }
};


Filters._boxBlurHorizontal = function (pixels, mask, w, h, radius, maskType) {
    var index = 0;
    var newColors = [];

    for (var y = 0; y < h; y++) {
        var hits = 0;
        var r = 0;
        var g = 0;
        var b = 0;
        var a = 0;
        for (var x = -radius * 4; x < w * 4; x += 4) {
            var oldPixel = x - radius * 4 - 4;
            if (oldPixel >= 0) {
                if ((maskType == 0) || (maskType == 1 && mask[index + oldPixel + 3] > 0) || (maskType == 2 && mask[index + oldPixel + 3] < 255)) {
                    a -= pixels[index + oldPixel + 3];
                    r -= pixels[index + oldPixel];
                    g -= pixels[index + oldPixel + 1];
                    b -= pixels[index + oldPixel + 2];
                    hits--;
                }
            }

            var newPixel = x + radius * 4;
            if (newPixel < w * 4) {
                if ((maskType == 0) || (maskType == 1 && mask[index + newPixel + 3] > 0) || (maskType == 2 && mask[index + newPixel + 3] < 255)) {
                    a += pixels[index + newPixel + 3];
                    r += pixels[index + newPixel];
                    g += pixels[index + newPixel + 1];
                    b += pixels[index + newPixel + 2];
                    hits++;
                }
            }

            if (x >= 0) {
                if ((maskType == 0) || (maskType == 1 && mask[index + x + 3] > 0) || (maskType == 2 && mask[index + x + 3] < 255)) {
                    if (hits == 0) {
                        newColors[x] = 0;
                        newColors[x + 1] = 0;
                        newColors[x + 2] = 0;
                        newColors[x + 3] = 0;
                    } else {
                        newColors[x] = Math.round(r / hits);
                        newColors[x + 1] = Math.round(g / hits);
                        newColors[x + 2] = Math.round(b / hits);
                        newColors[x + 3] = Math.round(a / hits);

                    }
                } else {
                    newColors[x] = 0;
                    newColors[x + 1] = 0;
                    newColors[x + 2] = 0;
                    newColors[x + 3] = 0;
                }
            }
        }
        for (var p = 0; p < w * 4; p += 4) {
            pixels[index + p] = newColors[p];
            pixels[index + p + 1] = newColors[p + 1];
            pixels[index + p + 2] = newColors[p + 2];
            pixels[index + p + 3] = newColors[p + 3];
        }

        index += w * 4;
    }
};

Filters._boxBlurVertical = function (pixels, mask, w, h, radius, maskType) {
    var newColors = [];
    var oldPixelOffset = -(radius + 1) * w * 4;
    var newPixelOffset = (radius) * w * 4;

    for (var x = 0; x < w * 4; x += 4) {
        var hits = 0;
        var r = 0;
        var g = 0;
        var b = 0;
        var a = 0;
        var index = -radius * w * 4 + x;
        for (var y = -radius; y < h; y++) {
            var oldPixel = y - radius - 1;
            if (oldPixel >= 0) {
                if ((maskType == 0) || (maskType == 1 && mask[index + oldPixelOffset + 3] > 0) || (maskType == 2 && mask[index + oldPixelOffset + 3] < 255)) {
                    a -= pixels[index + oldPixelOffset + 3];
                    r -= pixels[index + oldPixelOffset];
                    g -= pixels[index + oldPixelOffset + 1];
                    b -= pixels[index + oldPixelOffset + 2];
                    hits--;
                }

            }

            var newPixel = y + radius;
            if (newPixel < h) {
                if ((maskType == 0) || (maskType == 1 && mask[index + newPixelOffset + 3] > 0) || (maskType == 2 && mask[index + newPixelOffset + 3] < 255)) {
                    a += pixels[index + newPixelOffset + 3];
                    r += pixels[index + newPixelOffset];
                    g += pixels[index + newPixelOffset + 1];
                    b += pixels[index + newPixelOffset + 2];
                    hits++;
                }
            }

            if (y >= 0) {
                if ((maskType == 0) || (maskType == 1 && mask[y * w * 4 + x + 3] > 0) || (maskType == 2 && mask[y * w * 4 + x + 3] < 255)) {
                    if (hits == 0) {
                        newColors[4 * y] = 0;
                        newColors[4 * y + 1] = 0;
                        newColors[4 * y + 2] = 0;
                        newColors[4 * y + 3] = 0;
                    } else {
                        newColors[4 * y] = Math.round(r / hits);
                        newColors[4 * y + 1] = Math.round(g / hits);
                        newColors[4 * y + 2] = Math.round(b / hits);
                        newColors[4 * y + 3] = Math.round(a / hits);
                    }
                } else {
                    newColors[4 * y] = 0;
                    newColors[4 * y + 1] = 0;
                    newColors[4 * y + 2] = 0;
                    newColors[4 * y + 3] = 0;
                }
            }

            index += w * 4;
        }

        for (var y = 0; y < h; y++) {
            pixels[y * w * 4 + x] = newColors[4 * y];
            pixels[y * w * 4 + x + 1] = newColors[4 * y + 1];
            pixels[y * w * 4 + x + 2] = newColors[4 * y + 2];
            pixels[y * w * 4 + x + 3] = newColors[4 * y + 3];
        }
    }
};


Filters.blur = function (canvas, ctx, hRadius, vRadius, iterations, mask, maskType) {
    var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = imgData.data;
    Filters._premultiply(data);
    for (var i = 0; i < iterations; i++) {
        Filters._boxBlurHorizontal(data, mask, canvas.width, canvas.height, Math.floor(hRadius / 2), maskType);
        Filters._boxBlurVertical(data, mask, canvas.width, canvas.height, Math.floor(vRadius / 2), maskType);
    }

    Filters._unpremultiply(data);

    var width = canvas.width;
    var height = canvas.height;
    var retCanvas = createCanvas(width, height);
    var retImg = retCanvas.getContext("2d");
    retImg.putImageData(imgData, 0, 0);
    return retCanvas;
}

Filters._moveRGB = function (width, height, rgb, deltaX, deltaY, fill) {
    var img = createCanvas(width, height);

    var ig = img.getContext("2d");

    Filters._setRGB(ig, 0, 0, width, height, rgb);
    var retImg = createCanvas(width, height);
    retImg.width = width;
    retImg.height = height;
    var g = retImg.getContext("2d");
    g.fillStyle = fill;
    g.globalCompositeOperation = "copy";
    g.fillRect(0, 0, width, height);
    g.drawImage(img, deltaX, deltaY);
    return g.getImageData(0, 0, width, height).data;
};


Filters.FULL = 1;
Filters.INNER = 2;
Filters.OUTER = 3;

Filters._setRGB = function (ctx, x, y, width, height, data) {
    var id = ctx.createImageData(width, height);
    for (var i = 0; i < data.length; i++) {
        id.data[i] = data[i];
    }
    ctx.putImageData(id, x, y);
};

Filters.gradientGlow = function (srcCanvas, src, blurX, blurY, angle, distance, colors, ratios, type, iterations, strength, knockout) {
    var width = canvas.width;
    var height = canvas.height;
    var retCanvas = createCanvas(width, height);
    var retImg = retCanvas.getContext("2d");

    var gradCanvas = createCanvas(256, 1);

    var gradient = gradCanvas.getContext("2d");
    var grd = ctx.createLinearGradient(0, 0, 255, 0);
    for (var s = 0; s < colors.length; s++) {
        var v = "rgba(" + colors[s][0] + "," + colors[s][1] + "," + colors[s][2] + "," + colors[s][3] + ")";
        grd.addColorStop(ratios[s], v);
    }
    gradient.fillStyle = grd;
    gradient.fillRect(0, 0, 256, 1);
    var gradientPixels = gradient.getImageData(0, 0, gradCanvas.width, gradCanvas.height).data;

    var angleRad = angle / 180 * Math.PI;
    var moveX = (distance * Math.cos(angleRad));
    var moveY = (distance * Math.sin(angleRad));
    var srcPixels = src.getImageData(0, 0, width, height).data;
    var shadow = [];
    for (var i = 0; i < srcPixels.length; i += 4) {
        var alpha = srcPixels[i + 3];
        shadow[i] = 0;
        shadow[i + 1] = 0;
        shadow[i + 2] = 0;
        shadow[i + 3] = Math.round(alpha * strength);
    }
    var colorAlpha = "rgba(0,0,0,0)";
    shadow = Filters._moveRGB(width, height, shadow, moveX, moveY, colorAlpha);

    Filters._setRGB(retImg, 0, 0, width, height, shadow);

    var maskType = 0;
    if (type == Filters.INNER) {
        maskType = 1;
    }
    if (type == Filters.OUTER) {
        maskType = 2;
    }


    retCanvas = Filters.blur(retCanvas, retCanvas.getContext("2d"), blurX, blurY, iterations, srcPixels, maskType);
    retImg = retCanvas.getContext("2d");
    shadow = retImg.getImageData(0, 0, width, height).data;

    if (maskType != 0) {
        for (var i = 0; i < srcPixels.length; i += 4) {
            if ((maskType == 1 && srcPixels[i + 3] == 0) || (maskType == 2 && srcPixels[i + 3] == 255)) {
                shadow[i] = 0;
                shadow[i + 1] = 0;
                shadow[i + 2] = 0;
                shadow[i + 3] = 0;
            }
        }
    }


    for (var i = 0; i < shadow.length; i += 4) {
        var a = shadow[i + 3];
        shadow[i] = gradientPixels[a * 4];
        shadow[i + 1] = gradientPixels[a * 4 + 1];
        shadow[i + 2] = gradientPixels[a * 4 + 2];
        shadow[i + 3] = gradientPixels[a * 4 + 3];
    }

    Filters._setRGB(retImg, 0, 0, width, height, shadow);

    if (!knockout) {
        retImg.globalCompositeOperation = "destination-over";
        retImg.drawImage(srcCanvas, 0, 0);
    }

    return retCanvas;
};


Filters.dropShadow = function (canvas, src, blurX, blurY, angle, distance, color, inner, iterations, strength, knockout) {
    var width = canvas.width;
    var height = canvas.height;
    var srcPixels = src.getImageData(0, 0, width, height).data;
    var shadow = [];
    for (var i = 0; i < srcPixels.length; i += 4) {
        var alpha = srcPixels[i + 3];
        if (inner) {
            alpha = 255 - alpha;
        }
        shadow[i] = color[0];
        shadow[i + 1] = color[1];
        shadow[i + 2] = color[2];
        var sa = color[3] * alpha * strength;
        if (sa > 255)
            sa = 255;
        shadow[i + 3] = Math.round(sa);
    }
    var colorFirst = "#000000";
    var colorAlpha = "rgba(0,0,0,0)";
    var angleRad = angle / 180 * Math.PI;
    var moveX = (distance * Math.cos(angleRad));
    var moveY = (distance * Math.sin(angleRad));
    shadow = Filters._moveRGB(width, height, shadow, moveX, moveY, inner ? colorFirst : colorAlpha);


    var retCanvas = createCanvas(canvas.width, canvas.height);
    Filters._setRGB(retCanvas.getContext("2d"), 0, 0, width, height, shadow);
    if (blurX > 0 || blurY > 0) {
        retCanvas = Filters.blur(retCanvas, retCanvas.getContext("2d"), blurX, blurY, iterations, null, 0);
    }
    shadow = retCanvas.getContext("2d").getImageData(0, 0, width, height).data;

    var srcPixels = src.getImageData(0, 0, width, height).data;
    for (var i = 0; i < shadow.length; i += 4) {
        var mask = srcPixels[i + 3];
        if (!inner) {
            mask = 255 - mask;
        }
        shadow[i + 3] = mask * shadow[i + 3] / 255;
    }
    Filters._setRGB(retCanvas.getContext("2d"), 0, 0, width, height, shadow);

    if (!knockout) {
        var g = retCanvas.getContext("2d");
        g.globalCompositeOperation = "destination-over";
        g.drawImage(canvas, 0, 0);
    }

    return retCanvas;
};

Filters._cut = function (a, min, max) {
    if (a > max)
        a = max;
    if (a < min)
        a = min;
    return a;
}

Filters.gradientBevel = function (canvas, src, colors, ratios, blurX, blurY, strength, type, angle, distance, knockout, iterations) {
    var width = canvas.width;
    var height = canvas.height;
    var retImg = createCanvas(width, height);
    var srcPixels = src.getImageData(0, 0, width, height).data;

    var gradient = createCanvas(512, 1);
    var gg = gradient.getContext("2d");

    var grd = ctx.createLinearGradient(0, 0, 511, 0);
    for (var s = 0; s < colors.length; s++) {
        var v = "rgba(" + colors[s][0] + "," + colors[s][1] + "," + colors[s][2] + "," + colors[s][3] + ")";
        grd.addColorStop(ratios[s], v);
    }
    gg.fillStyle = grd;
    gg.globalCompositeOperation = "copy";
    gg.fillRect(0, 0, gradient.width, gradient.height);
    var gradientPixels = gg.getImageData(0, 0, gradient.width, gradient.height).data;


    if (type != Filters.OUTER) {
        var hilightIm = Filters.dropShadow(canvas, src, 0, 0, angle, distance, [255, 0, 0, 1], true, iterations, strength, true);
        var shadowIm = Filters.dropShadow(canvas, src, 0, 0, angle + 180, distance, [0, 0, 255, 1], true, iterations, strength, true);
        var h2 = createCanvas(width, height);
        var s2 = createCanvas(width, height);
        var hc = h2.getContext("2d");
        var sc = s2.getContext("2d");
        hc.drawImage(hilightIm, 0, 0);
        hc.globalCompositeOperation = "destination-out";
        hc.drawImage(shadowIm, 0, 0);

        sc.drawImage(shadowIm, 0, 0);
        sc.globalCompositeOperation = "destination-out";
        sc.drawImage(hilightIm, 0, 0);
        var shadowInner = s2;
        var hilightInner = h2;
    }
    if (type != Filters.INNER) {
        var hilightIm = Filters.dropShadow(canvas, src, 0, 0, angle + 180, distance, [255, 0, 0, 1], false, iterations, strength, true);
        var shadowIm = Filters.dropShadow(canvas, src, 0, 0, angle, distance, [0, 0, 255, 1], false, iterations, strength, true);
        var h2 = createCanvas(width, height);
        var s2 = createCanvas(width, height);
        var hc = h2.getContext("2d");
        var sc = s2.getContext("2d");
        hc.drawImage(hilightIm, 0, 0);
        hc.globalCompositeOperation = "destination-out";
        hc.drawImage(shadowIm, 0, 0);

        sc.drawImage(shadowIm, 0, 0);
        sc.globalCompositeOperation = "destination-out";
        sc.drawImage(hilightIm, 0, 0);
        var shadowOuter = s2;
        var hilightOuter = h2;
    }

    var hilightIm;
    var shadowIm;
    switch (type) {
        case Filters.OUTER:
            hilightIm = hilightOuter;
            shadowIm = shadowOuter;
            break;
        case Filters.INNER:
            hilightIm = hilightInner;
            shadowIm = shadowInner;
            break;
        case Filters.FULL:
            hilightIm = hilightInner;
            shadowIm = shadowInner;
            var hc = hilightIm.getContext("2d");
            hc.globalCompositeOperation = "source-over";
            hc.drawImage(hilightOuter, 0, 0);
            var sc = shadowIm.getContext("2d");
            sc.globalCompositeOperation = "source-over";
            sc.drawImage(shadowOuter, 0, 0);
            break;
    }

    var maskType = 0;
    if (type == Filters.INNER) {
        maskType = 1;
    }
    if (type == Filters.OUTER) {
        maskType = 2;
    }

    var retc = retImg.getContext("2d");
    retc.fillStyle = "#000000";
    retc.fillRect(0, 0, width, height);
    retc.drawImage(shadowIm, 0, 0);
    retc.drawImage(hilightIm, 0, 0);

    retImg = Filters.blur(retImg, retImg.getContext("2d"), blurX, blurY, iterations, srcPixels, maskType);
    var ret = retImg.getContext("2d").getImageData(0, 0, width, height).data;

    for (var i = 0; i < srcPixels.length; i += 4) {
        var ah = ret[i] * strength;
        var as = ret[i + 2] * strength;
        var ra = Filters._cut(ah - as, -255, 255);
        ret[i] = gradientPixels[4 * (255 + ra)];
        ret[i + 1] = gradientPixels[4 * (255 + ra) + 1];
        ret[i + 2] = gradientPixels[4 * (255 + ra) + 2];
        ret[i + 3] = gradientPixels[4 * (255 + ra) + 3];
    }
    Filters._setRGB(retImg.getContext("2d"), 0, 0, width, height, ret);


    if (!knockout) {
        var g = retImg.getContext("2d");
        g.globalCompositeOperation = "destination-over";
        g.drawImage(canvas, 0, 0);
    }
    return retImg;
}
Filters.bevel = function (canvas, src, blurX, blurY, strength, type, highlightColor, shadowColor, angle, distance, knockout, iterations) {
    return Filters.gradientBevel(canvas, src, [
        shadowColor,
        [shadowColor[0], shadowColor[1], shadowColor[2], 0],
        [highlightColor[0], highlightColor[1], highlightColor[2], 0],
        highlightColor
    ], [0, 127 / 255, 128 / 255, 1], blurX, blurY, strength, type, angle, distance, knockout, iterations);
}


//http://www.html5rocks.com/en/tutorials/canvas/imagefilters/
Filters.convolution = function (canvas, ctx, weights, opaque) {
    var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var side = Math.round(Math.sqrt(weights.length));
    var halfSide = Math.floor(side / 2);
    var src = pixels.data;
    var sw = pixels.width;
    var sh = pixels.height;
    // pad output by the convolution matrix
    var w = sw;
    var h = sh;
    var outCanvas = createCanvas(w, h);
    var outCtx = outCanvas.getContext("2d");
    var output = outCtx.getImageData(0, 0, w, h);
    var dst = output.data;
    // go through the destination image pixels
    var alphaFac = opaque ? 1 : 0;
    for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var sy = y;
            var sx = x;
            var dstOff = (y * w + x) * 4;
            // calculate the weighed sum of the source image pixels that
            // fall under the convolution matrix
            var r = 0, g = 0, b = 0, a = 0;
            for (var cy = 0; cy < side; cy++) {
                for (var cx = 0; cx < side; cx++) {
                    var scy = sy + cy - halfSide;
                    var scx = sx + cx - halfSide;
                    if (scy >= 0 && scy < sh && scx >= 0 && scx < sw) {
                        var srcOff = (scy * sw + scx) * 4;
                        var wt = weights[cy * side + cx];
                        r += src[srcOff] * wt;
                        g += src[srcOff + 1] * wt;
                        b += src[srcOff + 2] * wt;
                        a += src[srcOff + 3] * wt;
                    }
                }
            }
            dst[dstOff] = r;
            dst[dstOff + 1] = g;
            dst[dstOff + 2] = b;
            dst[dstOff + 3] = a + alphaFac * (255 - a);
        }
    }
    outCtx.putImageData(output, 0, 0);
    return outCanvas;
};

Filters.colorMatrix = function (canvas, ctx, m) {
    var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);

    var data = pixels.data;
    for (var i = 0; i < data.length; i += 4) {
        var r = i;
        var g = i + 1;
        var b = i + 2;
        var a = i + 3;

        var oR = data[r];
        var oG = data[g];
        var oB = data[b];
        var oA = data[a];

        data[r] = (m[0] * oR) + (m[1] * oG) + (m[2] * oB) + (m[3] * oA) + m[4];
        data[g] = (m[5] * oR) + (m[6] * oG) + (m[7] * oB) + (m[8] * oA) + m[9];
        data[b] = (m[10] * oR) + (m[11] * oG) + (m[12] * oB) + (m[13] * oA) + m[14];
        data[a] = (m[15] * oR) + (m[16] * oG) + (m[17] * oB) + (m[18] * oA) + m[19];
    }
    var outCanvas = createCanvas(canvas.width, canvas.height);
    var outCtx = outCanvas.getContext("2d");
    outCtx.putImageData(pixels, 0, 0);
    return outCanvas;
};


Filters.glow = function (canvas, src, blurX, blurY, strength, color, inner, knockout, iterations) {
    return Filters.dropShadow(canvas, src, blurX, blurY, 45, 0, color, inner, iterations, strength, knockout);
};


var BlendModes = {};

BlendModes._cut = function (v) {
    if (v < 0)
        v = 0;
    if (v > 255)
        v = 255;
    return v;
};

BlendModes.normal = function (src, dst, result, pos) {
    var am = (255 - src[pos + 3]) / 255;
    result[pos] = this._cut(src[pos] * src[pos + 3] / 255 + dst[pos] * dst[pos + 3] / 255 * am);
    result[pos + 1] = this._cut(src[pos + 1] * src[pos + 3] / 255 + dst[pos + 1] * dst[pos + 3] / 255 * am);
    result[pos + 2] = this._cut(src[pos + 2] * src[pos + 3] / 255 + dst[pos + 2] * dst[pos + 3] / 255 * am);
    result[pos + 3] = this._cut(src[pos + 3] + dst[pos + 3] * am);
};

BlendModes.layer = function (src, dst, result, pos) {
    BlendModes.normal(src, dst, result, pos);
};

BlendModes.multiply = function (src, dst, result, pos) {
    result[pos + 0] = (src[pos + 0] * dst[pos + 0]) >> 8;
    result[pos + 1] = (src[pos + 1] * dst[pos + 1]) >> 8;
    result[pos + 2] = (src[pos + 2] * dst[pos + 2]) >> 8;
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes.screen = function (src, dst, result, pos) {
    result[pos + 0] = 255 - ((255 - src[pos + 0]) * (255 - dst[pos + 0]) >> 8);
    result[pos + 1] = 255 - ((255 - src[pos + 1]) * (255 - dst[pos + 1]) >> 8);
    result[pos + 2] = 255 - ((255 - src[pos + 2]) * (255 - dst[pos + 2]) >> 8);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes.lighten = function (src, dst, result, pos) {
    result[pos + 0] = Math.max(src[pos + 0], dst[pos + 0]);
    result[pos + 1] = Math.max(src[pos + 1], dst[pos + 1]);
    result[pos + 2] = Math.max(src[pos + 2], dst[pos + 2]);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes.darken = function (src, dst, result, pos) {
    result[pos + 0] = Math.min(src[pos + 0], dst[pos + 0]);
    result[pos + 1] = Math.min(src[pos + 1], dst[pos + 1]);
    result[pos + 2] = Math.min(src[pos + 2], dst[pos + 2]);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes.difference = function (src, dst, result, pos) {
    result[pos + 0] = Math.abs(dst[pos + 0] - src[pos + 0]);
    result[pos + 1] = Math.abs(dst[pos + 1] - src[pos + 1]);
    result[pos + 2] = Math.abs(dst[pos + 2] - src[pos + 2]);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes.add = function (src, dst, result, pos) {
    result[pos + 0] = Math.min(255, src[pos + 0] + dst[pos + 0]);
    result[pos + 1] = Math.min(255, src[pos + 1] + dst[pos + 1]);
    result[pos + 2] = Math.min(255, src[pos + 2] + dst[pos + 2]);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3]);
};

BlendModes.subtract = function (src, dst, result, pos) {
    result[pos + 0] = Math.max(0, src[pos + 0] + dst[pos + 0] - 256);
    result[pos + 1] = Math.max(0, src[pos + 1] + dst[pos + 1] - 256);
    result[pos + 2] = Math.max(0, src[pos + 2] + dst[pos + 2] - 256);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes.invert = function (src, dst, result, pos) {
    result[pos + 0] = 255 - dst[pos + 0];
    result[pos + 1] = 255 - dst[pos + 1];
    result[pos + 2] = 255 - dst[pos + 2];
    result[pos + 3] = src[pos + 3];
};

BlendModes.alpha = function (src, dst, result, pos) {
    result[pos + 0] = src[pos + 0];
    result[pos + 1] = src[pos + 1];
    result[pos + 2] = src[pos + 2];
    result[pos + 3] = dst[pos + 3]; //?
};

BlendModes.erase = function (src, dst, result, pos) {
    result[pos + 0] = src[pos + 0];
    result[pos + 1] = src[pos + 1];
    result[pos + 2] = src[pos + 2];
    result[pos + 3] = 255 - dst[pos + 3]; //?
};

BlendModes.overlay = function (src, dst, result, pos) {
    result[pos + 0] = dst[pos + 0] < 128 ? dst[pos + 0] * src[pos + 0] >> 7
            : 255 - ((255 - dst[pos + 0]) * (255 - src[pos + 0]) >> 7);
    result[pos + 1] = dst[pos + 1] < 128 ? dst[pos + 1] * src[pos + 1] >> 7
            : 255 - ((255 - dst[pos + 1]) * (255 - src[pos + 1]) >> 7);
    result[pos + 2] = dst[pos + 2] < 128 ? dst[pos + 2] * src[pos + 2] >> 7
            : 255 - ((255 - dst[pos + 2]) * (255 - src[pos + 2]) >> 7);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes.hardlight = function (src, dst, result, pos) {
    result[pos + 0] = src[pos + 0] < 128 ? dst[pos + 0] * src[pos + 0] >> 7
            : 255 - ((255 - src[pos + 0]) * (255 - dst[pos + 0]) >> 7);
    result[pos + 1] = src[pos + 1] < 128 ? dst[pos + 1] * src[pos + 1] >> 7
            : 255 - ((255 - src[pos + 1]) * (255 - dst[pos + 1]) >> 7);
    result[pos + 2] = src[pos + 2] < 128 ? dst[pos + 2] * src[pos + 2] >> 7
            : 255 - ((255 - src[pos + 2]) * (255 - dst[pos + 2]) >> 7);
    result[pos + 3] = Math.min(255, src[pos + 3] + dst[pos + 3] - (src[pos + 3] * dst[pos + 3]) / 255);
};

BlendModes._list = [
    BlendModes.normal,
    BlendModes.normal,
    BlendModes.layer,
    BlendModes.multiply,
    BlendModes.screen,
    BlendModes.lighten,
    BlendModes.darken,
    BlendModes.difference,
    BlendModes.add,
    BlendModes.subtract,
    BlendModes.invert,
    BlendModes.alpha,
    BlendModes.erase,
    BlendModes.overlay,
    BlendModes.hardlight
];

BlendModes.blendData = function (srcPixel, dstPixel, retData, modeIndex) {
    var result = [];
    var retPixel = [];
    var alpha = 1.0;
    for (var i = 0; i < retData.length; i += 4) {
        this._list[modeIndex](srcPixel, dstPixel, result, i);

        retPixel[i + 0] = this._cut(dstPixel[i + 0] + (result[i + 0] - dstPixel[i + 0]) * alpha);
        retPixel[i + 1] = this._cut(dstPixel[i + 1] + (result[i + 1] - dstPixel[i + 1]) * alpha);
        retPixel[i + 2] = this._cut(dstPixel[i + 2] + (result[i + 2] - dstPixel[i + 2]) * alpha);
        retPixel[i + 3] = this._cut(dstPixel[i + 3] + (result[i + 3] - dstPixel[i + 3]) * alpha);

        var af = srcPixel[i + 3] / 255;
        retData[i + 0] = this._cut((1 - af) * dstPixel[i + 0] + af * retPixel[i + 0]);
        retData[i + 1] = this._cut((1 - af) * dstPixel[i + 1] + af * retPixel[i + 1]);
        retData[i + 2] = this._cut((1 - af) * dstPixel[i + 2] + af * retPixel[i + 2]);
        retData[i + 3] = this._cut((1 - af) * dstPixel[i + 3] + af * retPixel[i + 3]);
    }
};

BlendModes.blendCanvas = function (src, dst, result, modeIndex) {
    var width = src.width;
    var height = src.height;
    var rctx = result.getContext("2d");
    var sctx = src.getContext("2d");
    var dctx = dst.getContext("2d");
    var ridata = rctx.getImageData(0, 0, width, height);
    var sidata = sctx.getImageData(0, 0, width, height);
    var didata = dctx.getImageData(0, 0, width, height);

    this.blendData(sidata.data, didata.data, ridata.data, modeIndex);
    rctx.putImageData(ridata, 0, 0);
};


function concatMatrix(m1, m2) {
    var a1 = m1[0], b1 = m1[1], c1 = m1[2], d1 = m1[3], e1 = m1[4], f1 = m1[5];
    var a2 = m2[0], b2 = m2[1], c2 = m2[2], d2 = m2[3], e2 = m2[4], f2 = m2[5];
    return [
        a2 * a1 + c2 * b1,
        b2 * a1 + d2 * b1,
        a2 * c1 + c2 * d1,
        b2 * c1 + d2 * d1,
        a2 * e1 + c2 * f1 + e2,
        b2 * e1 + d2 * f1 + f2
    ];
}

(function () {
    if (typeof CanvasRenderingContext2D === "undefined") return;
    var proto = CanvasRenderingContext2D.prototype;
    if (proto._TP_enhanced) return;
    proto._TP_enhanced = true;

    var origSave = proto.save;
    var origRestore = proto.restore;
    var origTransform = proto.transform;
    var origSetTransform = proto.setTransform;
    var origResetTransform = proto.resetTransform;

    proto.save = function () {
        if (this._enhanced) {
            this._savedMatrices.push(this._matrix);
        }
        return origSave.call(this);
    };

    proto.restore = function () {
        if (this._enhanced) {
            if (this._savedMatrices.length === 0) return;
            origRestore.call(this);
            this._matrix = this._savedMatrices.pop();
            return;
        }
        return origRestore.call(this);
    };

    proto.transform = function (a, b, c, d, e, f) {
        if (this._enhanced) {
            var m = this._matrix;
            // Use local vars for a tiny speedup, but allocate a fresh array
            // for _matrix. save() pushes the _matrix reference onto the stack,
            // so mutating in place would corrupt saved matrices and drift the
            // CTM over a frame.
            var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5];
            this._matrix = [
                m0 * a + m2 * b,
                m1 * a + m3 * b,
                m0 * c + m2 * d,
                m1 * c + m3 * d,
                m0 * e + m2 * f + m4,
                m1 * e + m3 * f + m5
            ];
        }
        return origTransform.call(this, a, b, c, d, e, f);
    };

    proto.setTransform = function (a, b, c, d, e, f) {
        if (this._enhanced) {
            if (a && typeof a === 'object') {
                this._matrix = [a.a, a.b, a.c, a.d, a.e, a.f];
            } else {
                this._matrix = [a, b, c, d, e, f];
            }
        }
        return origSetTransform.apply(this, arguments);
    };

    proto.resetTransform = function () {
        if (this._enhanced) {
            this._matrix = [1, 0, 0, 1, 0, 0];
        }
        return origResetTransform ? origResetTransform.call(this) : origSetTransform.call(this, 1, 0, 0, 1, 0, 0);
    };

    proto.applyTransforms = function (m) {
        this.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    };

    proto.applyTransformToPoint = function (p) {
        var m = this._matrix;
        return {
            x: m[0] * p.x + m[2] * p.y + m[4],
            y: m[1] * p.x + m[3] * p.y + m[5]
        };
    };
})();

var enhanceContext = function (context) {
    if (!context._enhanced) {
        context._enhanced = true;
        if (!context.applyTransforms) {
            context.applyTransforms = function (m) { this.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); };
            context.applyTransformToPoint = function (p) {
                var m = this._matrix;
                return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
            };
        }
    }
    context._matrix = [1, 0, 0, 1, 0, 0];
    context._savedMatrices = [];
    return context;
};

var cxform = function (r_add, g_add, b_add, a_add, r_mult, g_mult, b_mult, a_mult) {
    this.r_add = r_add;
    this.g_add = g_add;
    this.b_add = b_add;
    this.a_add = a_add;
    this.r_mult = r_mult;
    this.g_mult = g_mult;
    this.b_mult = b_mult;
    this.a_mult = a_mult;
    this._empty = (r_add === 0 && g_add === 0 && b_add === 0 && a_add === 0 &&
                   r_mult === 255 && g_mult === 255 && b_mult === 255 && a_mult === 255);
};

cxform.prototype._cut = function (v, min, max) {
    if (v < min) return min;
    if (v > max) return max;
    return v;
};

cxform.prototype.apply = function (c) {
    if (this._empty) return c;
    var d = c;
    d[0] = this._cut(Math.round(d[0] * this.r_mult / 255 + this.r_add), 0, 255);
    d[1] = this._cut(Math.round(d[1] * this.g_mult / 255 + this.g_add), 0, 255);
    d[2] = this._cut(Math.round(d[2] * this.b_mult / 255 + this.b_add), 0, 255);
    d[3] = this._cut(d[3] * this.a_mult / 255 + this.a_add / 255, 0, 1);
    return d;
};

cxform.prototype.applyToImage = function (fimg) {
    if (this._empty || !fimg) {
        return fimg;
    }
    var key = this.r_add + "," + this.g_add + "," + this.b_add + "," + this.a_add + "," +
              this.r_mult + "," + this.g_mult + "," + this.b_mult + "," + this.a_mult;
    var cache = fimg._cxCache;
    if (cache && cache[key]) return cache[key];
    if (!cache || Object.keys(cache).length > 48) cache = fimg._cxCache = {};
    var icanvas = createCanvas(fimg.width, fimg.height);
    var ictx = icanvas.getContext("2d");
    ictx.drawImage(fimg, 0, 0);
    var imdata = ictx.getImageData(0, 0, icanvas.width, icanvas.height);
    var idata = imdata.data;
    var len = idata.length;
    var r_mult = this.r_mult, g_mult = this.g_mult, b_mult = this.b_mult, a_mult = this.a_mult;
    var r_add = this.r_add, g_add = this.g_add, b_add = this.b_add, a_add = this.a_add;
    for (var i = 0; i < len; i += 4) {
        var r = Math.round(idata[i] * r_mult / 255 + r_add);
        var g = Math.round(idata[i + 1] * g_mult / 255 + g_add);
        var b = Math.round(idata[i + 2] * b_mult / 255 + b_add);
        var a = Math.round((idata[i + 3] * a_mult / 255 + a_add));
        idata[i] = r < 0 ? 0 : r > 255 ? 255 : r;
        idata[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        idata[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        idata[i + 3] = a < 0 ? 0 : a > 255 ? 255 : a;
    }
    ictx.putImageData(imdata, 0, 0);
    cache[key] = icanvas;
    return icanvas;
};

cxform.prototype.merge = function (cx) {
    return new cxform(
        this.r_add + cx.r_add,
        this.g_add + cx.g_add,
        this.b_add + cx.b_add,
        this.a_add + cx.a_add,
        this.r_mult * cx.r_mult / 255,
        this.g_mult * cx.g_mult / 255,
        this.b_mult * cx.b_mult / 255,
        this.a_mult * cx.a_mult / 255
    );
};

cxform.prototype.isEmpty = function () {
    return this._empty;
};

var placeRaw = function (obj, canvas, ctx, matrix, ctrans, blendMode, frame, ratio, time) {
    ctx.save();
    ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    if (blendMode > 1) {
        var oldctx = ctx;
        var ncanvas = createCanvas(canvas.width, canvas.height);
        ctx = ncanvas.getContext("2d");
        enhanceContext(ctx);
        ctx.applyTransforms(oldctx._matrix);
    }
    var drawFn = window[obj];
    if (typeof drawFn !== "function") {
        eval(obj + (blendMode > 1
            ? "(ctx,new cxform(0,0,0,0,255,255,255,255),frame,ratio,time);"
            : "(ctx,ctrans,frame,ratio,time);"));
    } else if (blendMode > 1) {
        drawFn(ctx, new cxform(0, 0, 0, 0, 255, 255, 255, 255), frame, ratio, time);
    } else {
        drawFn(ctx, ctrans, frame, ratio, time);
    }
    if (blendMode > 1) {
        BlendModes.blendCanvas(ctrans.applyToImage(ncanvas), canvas, canvas, blendMode);
        ctx = oldctx;
    }
    ctx.restore();
}

var transformPoint = function (matrix, p) {
    var ret = {};
    ret.x = matrix[0] * p.x + matrix[2] * p.y + matrix[4];
    ret.y = matrix[1] * p.x + matrix[3] * p.y + matrix[5];
    return ret;
}

var transformRect = function (matrix, rect) {
    var minX = Number.MAX_VALUE;
    var minY = Number.MAX_VALUE;
    var maxX = Number.MIN_VALUE;
    var maxY = Number.MIN_VALUE;
    var point = transformPoint(matrix, {x: rect.xMin, y: rect.yMin});
    if (point.x < minX) {
        minX = point.x;
    }
    if (point.x > maxX) {
        maxX = point.x;
    }
    if (point.y < minY) {
        minY = point.y;
    }
    if (point.y > maxY) {
        maxY = point.y;
    }
    point = transformPoint(matrix, {x: rect.xMax, y: rect.yMin});
    if (point.x < minX) {
        minX = point.x;
    }
    if (point.x > maxX) {
        maxX = point.x;
    }
    if (point.y < minY) {
        minY = point.y;
    }
    if (point.y > maxY) {
        maxY = point.y;
    }
    point = transformPoint(matrix, {x: rect.xMin, y: rect.yMax});
    if (point.x < minX) {
        minX = point.x;
    }
    if (point.x > maxX) {
        maxX = point.x;
    }
    if (point.y < minY) {
        minY = point.y;
    }
    if (point.y > maxY) {
        maxY = point.y;
    }
    point = transformPoint(matrix, {x: rect.xMax, y: rect.yMax});
    if (point.x < minX) {
        minX = point.x;
    }
    if (point.x > maxX) {
        maxX = point.x;
    }
    if (point.y < minY) {
        minY = point.y;
    }
    if (point.y > maxY) {
        maxY = point.y;
    }
    return {xMin: minX, xMax: maxX, yMin: minY, yMax: maxY};
}

var getTranslateMatrix = function (translateX, translateY) {
    return [1, 0, 0, 1, translateX, translateY];
}

var getRectWidth = function (rect) {
    return rect.xMax - rect.xMin;
}

var getRectHeight = function (rect) {
    return rect.yMax - rect.yMin;
}

var rint = function (v) {
    return Math.round(v);
}

var scaleMatrix = function (m, factorX, factorY) {
    return [
        m[0] * factorX,
        m[1] * factorX,
        m[2] * factorY,
        m[3] * factorY,
        m[4],
        m[5]
    ];
};

var translateMatrix = function (m, x, y) {
    return [
        m[0],
        m[1],
        m[2],
        m[3],
        m[0] * x + m[2] * y + m[4],
        m[1] * x + m[3] * y + m[5]
    ];
};

var place = function (obj, canvas, ctx, matrix, ctrans, blendMode, frame, ratio, time) {
    if ((typeof scalingGrids[obj]) !== "undefined") {
        var unitScaleMatrix = [1 / 20, 0, 0, 1 / 20, 0, 0];
        var boundRect = boundRects[obj];
        var scalingRect = scalingGrids[obj];
        var exRect = boundRect;
        var newRect = exRect;
        var transform = matrix;

        var transform2;
        newRect = transformRect(transform, exRect);
        transform = transform.slice();

        transform = getTranslateMatrix(newRect.xMin, newRect.yMin);

        transform = concatMatrix(unitScaleMatrix, transform);

        var scaleWidth = getRectWidth(newRect) * 20 - scalingRect.xMin - (boundRect.xMax - scalingRect.xMax);
        var originalWidth = getRectWidth(boundRect) - scalingRect.xMin - (boundRect.xMax - scalingRect.xMax);
        var scaleX = scaleWidth / originalWidth;

        var scaleHeight = getRectHeight(newRect) * 20 - scalingRect.yMin - (boundRect.yMax - scalingRect.yMax);
        var originalHeight = getRectHeight(boundRect) - scalingRect.yMin - (boundRect.yMax - scalingRect.yMax);
        var scaleY = scaleHeight / originalHeight;


        //top left
        ctx.save();
        drawPath(ctx, ""
                + "M " + newRect.xMin + " " + newRect.yMin + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + newRect.yMin + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + newRect.xMin + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " Z"
                );
        ctx.clip();
        placeRaw(obj, canvas, ctx, transform, ctrans, blendMode, frame, ratio, time);

        ctx.restore();

        //bottom left
        transform2 = transform.slice();
        transform2[5] /*translateY*/ += getRectHeight(newRect) - getRectHeight(boundRect) / 20;

        ctx.save();

        drawPath(ctx, "M " + newRect.xMin + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + newRect.yMax + " "
                + "L " + newRect.xMin + " " + newRect.yMax + " Z"
                )
        ctx.clip();

        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();

        //top right
        transform2 = transform.slice();
        transform2[4] /*translateX*/ += getRectWidth(newRect) - getRectWidth(boundRect) / 20;
        ctx.save();
        drawPath(ctx, "M " + (newRect.xMax - rint((exRect.xMax - scalingRect.xMax) / 20)) + " " + newRect.yMin + " "
                + "L " + newRect.xMax + " " + newRect.yMin + " "
                + "L " + newRect.xMax + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + (newRect.xMax - rint((exRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " Z");

        ctx.clip();

        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();

        //bottom right
        transform2 = transform.slice();
        transform2[4] /*translateX*/ += getRectWidth(newRect) - getRectWidth(boundRect) / 20;
        transform2[5] /*translateY*/ += getRectHeight(newRect) - getRectHeight(boundRect) / 20;
        ctx.save();
        drawPath(ctx, "M " + (newRect.xMax - rint((exRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + newRect.xMax + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + newRect.xMax + " " + newRect.yMax + " "
                + "L " + (newRect.xMax - rint((exRect.xMax - scalingRect.xMax) / 20)) + " " + newRect.yMax + " Z");

        ctx.clip();

        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();


        //top
        transform2 = transform.slice();
        ctx.save();
        transform2 = translateMatrix(transform2, scalingRect.xMin, 0);
        transform2 = scaleMatrix(transform2, scaleX, 1);
        transform2 = translateMatrix(transform2, -scalingRect.xMin, 0);

        drawPath(ctx, "M " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + newRect.yMin + " "
                + "L " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + newRect.yMin + " "
                + "L " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " Z");

        ctx.clip();
        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();

        //left
        transform2 = transform.slice();
        ctx.save();
        transform2 = translateMatrix(transform2, 0, scalingRect.yMin);
        transform2 = scaleMatrix(transform2, 1, scaleY);
        transform2 = translateMatrix(transform2, 0, -scalingRect.yMin);

        drawPath(ctx, "M " + newRect.xMin + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + newRect.xMin + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " Z");

        ctx.clip();
        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();

        //bottom
        transform2 = transform.slice();
        ctx.save();
        transform2 = translateMatrix(transform2, scalingRect.xMin, 0);
        transform2 = scaleMatrix(transform2, scaleX, 1);
        transform2 = translateMatrix(transform2, -scalingRect.xMin, 0);

        transform2 = translateMatrix(transform2, 0, getRectHeight(newRect) * 20 - getRectHeight(boundRect));

        drawPath(ctx, "M " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + newRect.yMax + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + newRect.yMax + " Z");

        ctx.clip();
        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();

        //right
        transform2 = transform.slice();
        ctx.save();
        transform2 = translateMatrix(transform2, 0, scalingRect.yMin);
        transform2 = scaleMatrix(transform2, 1, scaleY);
        transform2 = translateMatrix(transform2, 0, -scalingRect.yMin);

        transform2 = translateMatrix(transform2, getRectWidth(newRect) * 20 - getRectWidth(boundRect), 0);

        drawPath(ctx, "M " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + newRect.xMax + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + newRect.xMax + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " Z");

        ctx.clip();
        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();

        //center
        transform2 = transform.slice();
        ctx.save();
        transform2 = translateMatrix(transform2, scalingRect.xMin, scalingRect.yMin);
        transform2 = scaleMatrix(transform2, scaleX, scaleY);
        transform2 = translateMatrix(transform2, -scalingRect.xMin, -scalingRect.yMin);

        drawPath(ctx, "M " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMin + rint(scalingRect.yMin / 20)) + " "
                + "L " + (newRect.xMax - rint((boundRect.xMax - scalingRect.xMax) / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " "
                + "L " + (newRect.xMin + rint(scalingRect.xMin / 20)) + " " + (newRect.yMax - rint((boundRect.yMax - scalingRect.yMax) / 20)) + " Z");

        ctx.clip();
        placeRaw(obj, canvas, ctx, transform2, ctrans, blendMode, frame, ratio, time);
        ctx.restore();
        return;
    }
    placeRaw(obj, canvas, ctx, matrix, ctrans, blendMode, frame, ratio, time);
}

var _colorCache = {};
var tocolor = function (c) {
    var a = c[3];
    if (a === 1) {
        var key = (c[0] << 16) | (c[1] << 8) | c[2];
        var cached = _colorCache[key];
        if (cached !== undefined) return cached;
        var r = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",1)";
        _colorCache[key] = r;
        return r;
    }
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
};

var _morphPathCache = new Map();

function parseMorphPathString(p) {
    var cached = _morphPathCache.get(p);
    if (cached) return cached;

    var parts = p.split(" ");
    var len = parts.length;
    var ops = [];
    var drawCommand = "";
    for (var i = 0; i < len; i++) {
        var tok = parts[i];
        switch (tok) {
            case '':
                break;
            case 'L':
            case 'M':
            case 'Q':
                drawCommand = tok;
                break;
            default:
                switch (drawCommand) {
                    case 'L':
                        ops.push(1, +tok, +parts[i + 1], +parts[i + 2], +parts[i + 3]);
                        i += 3;
                        break;
                    case 'M':
                        ops.push(2, +tok, +parts[i + 1], +parts[i + 2], +parts[i + 3]);
                        i += 3;
                        break;
                    case 'Q':
                        ops.push(3, +tok, +parts[i + 1], +parts[i + 2], +parts[i + 3],
                                    +parts[i + 4], +parts[i + 5], +parts[i + 6], +parts[i + 7]);
                        i += 7;
                        break;
                }
                break;
        }
    }
    cached = { ops: ops };
    _morphPathCache.set(p, cached);
    return cached;
}

function useRatio(v1, v2, ratio) {
    return v1 + (v2 - v1) * (ratio / 65535);
}

function trackStrokePad(ctx, scaleModeHint) {
    // Raster-cache bounds accounting: a stroke extends past the recorded path
    // points, so the metering pass must pad the local box or the cached
    // bitmap would clip the line. NORMAL/VERTICAL/HORIZONTAL strokes are
    // widened by 20x lineWidth against the (near-uniform) device scale, which
    // is a constant 10x lineWidth in local units; NONE strokes are a constant
    // device-space width, recorded separately and divided by the raster
    // scale when the cache entry is created.
    if (!ctx._trackLocal) return;
    var lw = ctx.lineWidth || 0;
    if (scaleModeHint === "NONE") {
        if (lw / 2 > (ctx._trackPadConst || 0)) ctx._trackPadConst = lw / 2;
    } else {
        if (lw * 10 > (ctx._trackPad || 0)) ctx._trackPad = lw * 10;
    }
}

function drawMorphPath(ctx, p, ratio, doStroke, scaleMode) {
    var parsed = parseMorphPathString(p);
    var ops = parsed.ops;
    var len = ops.length;
    var m = ctx._matrix;

    if (doStroke) {
        trackStrokePad(ctx, scaleMode);
        switch (scaleMode) {
            case "NONE":
                break;
            case "NORMAL":
                ctx.lineWidth *= 20 * Math.max(m[0], m[3]);
                break;
            case "VERTICAL":
                ctx.lineWidth *= 20 * m[3];
                break;
            case "HORIZONTAL":
                ctx.lineWidth *= 20 * m[0];
                break;
        }

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        ctx.beginPath();
        var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5];
        var rf = ratio / 65535;
        for (var i = 0; i < len; ) {
            var cmd = ops[i++];
            if (cmd === 1) {
                var lx = ops[i] + (ops[i + 1] - ops[i]) * rf;
                var ly = ops[i + 2] + (ops[i + 3] - ops[i + 2]) * rf;
                ctx.lineTo(m0 * lx + m2 * ly + m4, m1 * lx + m3 * ly + m5);
                i += 4;
            } else if (cmd === 2) {
                var mx = ops[i] + (ops[i + 1] - ops[i]) * rf;
                var my = ops[i + 2] + (ops[i + 3] - ops[i + 2]) * rf;
                ctx.moveTo(m0 * mx + m2 * my + m4, m1 * mx + m3 * my + m5);
                i += 4;
            } else if (cmd === 3) {
                var cx = ops[i] + (ops[i + 1] - ops[i]) * rf;
                var cy = ops[i + 2] + (ops[i + 3] - ops[i + 2]) * rf;
                var qx = ops[i + 4] + (ops[i + 5] - ops[i + 4]) * rf;
                var qy = ops[i + 6] + (ops[i + 7] - ops[i + 6]) * rf;
                ctx.quadraticCurveTo(
                    m0 * cx + m2 * cy + m4, m1 * cx + m3 * cy + m5,
                    m0 * qx + m2 * qy + m4, m1 * qx + m3 * qy + m5
                );
                i += 8;
            }
        }
        ctx.stroke();
        ctx.restore();
        return;
    }

    ctx.beginPath();
    var rf = ratio / 65535;
    for (var i = 0; i < len; ) {
        var cmd = ops[i++];
        if (cmd === 1) {
            ctx.lineTo(ops[i] + (ops[i + 1] - ops[i]) * rf, ops[i + 2] + (ops[i + 3] - ops[i + 2]) * rf);
            i += 4;
        } else if (cmd === 2) {
            ctx.moveTo(ops[i] + (ops[i + 1] - ops[i]) * rf, ops[i + 2] + (ops[i + 3] - ops[i + 2]) * rf);
            i += 4;
        } else if (cmd === 3) {
            ctx.quadraticCurveTo(
                ops[i] + (ops[i + 1] - ops[i]) * rf, ops[i + 2] + (ops[i + 3] - ops[i + 2]) * rf,
                ops[i + 4] + (ops[i + 5] - ops[i + 4]) * rf, ops[i + 6] + (ops[i + 7] - ops[i + 6]) * rf
            );
            i += 8;
        }
    }
}

var _parsedPathCache = new Map();

function parsePathString(p) {
    var cached = _parsedPathCache.get(p);
    if (cached) return cached;

    var parts = p.split(" ");
    var len = parts.length;
    var ops = [];
    var rawCoords = [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var count = 0;
    var drawCommand = "";

    function addPt(x, y) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        count++;
    }

    for (var i = 0; i < len; i++) {
        var tok = parts[i];
        switch (tok) {
            case 'L':
            case 'M':
            case 'Q':
                drawCommand = tok;
                break;
            case 'Z':
                // Both consumers need the close: the fill branch reads ops,
                // the stroked replay reads rawCoords. Omitting it from
                // rawCoords would silently drop closePath from stroked paths.
                ops.push(0);
                rawCoords.push(0);
                break;
            default:
                switch (drawCommand) {
                    case 'L': {
                        var x = +tok, y = +parts[i + 1];
                        ops.push(1, x, y);
                        addPt(x, y);
                        rawCoords.push(1, x, y);
                        i++;
                        break;
                    }
                    case 'M': {
                        var x = +tok, y = +parts[i + 1];
                        ops.push(2, x, y);
                        addPt(x, y);
                        rawCoords.push(2, x, y);
                        i++;
                        break;
                    }
                    case 'Q': {
                        var cx = +tok, cy = +parts[i + 1], x = +parts[i + 2], y = +parts[i + 3];
                        ops.push(3, cx, cy, x, y);
                        addPt(cx, cy);
                        addPt(x, y);
                        rawCoords.push(3, cx, cy, x, y);
                        i += 3;
                        break;
                    }
                }
                break;
        }
    }

    cached = {
        ops: ops,
        rawCoords: rawCoords,
        minX: minX,
        minY: minY,
        maxX: maxX,
        maxY: maxY,
        count: count
    };
    _parsedPathCache.set(p, cached);
    return cached;
}

function drawPath(ctx, p, doStroke, scaleMode) {
    var parsed = parsePathString(p);

    if (doStroke) {
        trackStrokePad(ctx, scaleMode);
        var m = ctx._matrix;
        switch (scaleMode) {
            case "NONE":
                break;
            case "NORMAL":
                ctx.lineWidth *= 20 * Math.max(m[0], m[3]);
                break;
            case "VERTICAL":
                ctx.lineWidth *= 20 * m[3];
                break;
            case "HORIZONTAL":
                ctx.lineWidth *= 20 * m[0];
                break;
        }

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        ctx.beginPath();
        var raw = parsed.rawCoords;
        var rlen = raw.length;
        var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5];
        for (var j = 0; j < rlen; ) {
            var op = raw[j++];
            if (op === 1) {
                var x = raw[j++], y = raw[j++];
                ctx.lineTo(m0 * x + m2 * y + m4, m1 * x + m3 * y + m5);
            } else if (op === 2) {
                var x = raw[j++], y = raw[j++];
                ctx.moveTo(m0 * x + m2 * y + m4, m1 * x + m3 * y + m5);
            } else if (op === 3) {
                var cx = raw[j++], cy = raw[j++], x = raw[j++], y = raw[j++];
                ctx.quadraticCurveTo(
                    m0 * cx + m2 * cy + m4, m1 * cx + m3 * cy + m5,
                    m0 * x + m2 * y + m4, m1 * x + m3 * y + m5
                );
            } else if (op === 0) {
                ctx.closePath();
            }
        }
        ctx.stroke();
        ctx.restore();
        return;
    }

    ctx.beginPath();
    var ops = parsed.ops;
    var len = ops.length;
    for (var i = 0; i < len; ) {
        var op = ops[i++];
        if (op === 1) {
            ctx.lineTo(ops[i++], ops[i++]);
        } else if (op === 2) {
            ctx.moveTo(ops[i++], ops[i++]);
        } else if (op === 3) {
            ctx.quadraticCurveTo(ops[i++], ops[i++], ops[i++], ops[i++]);
        } else if (op === 0) {
            ctx.closePath();
        }
    }
}

// Bitmap and radial fills use fillRect(-16384, -16384, 32768, 32768). Under
// the bitmap matrix (about 20x) that is a 655kpx rect; Canvas2D pattern fills
// rasterize that before the clip. The clip was recorded in the user space just
// before that matrix, so filling the inverse-transformed clip bounds paints
// the same pixels.
(function installFastDraw() {
    if (typeof CanvasRenderingContext2D === "undefined") return;
    var proto = CanvasRenderingContext2D.prototype;
    var origFillRect = proto.fillRect;
    var origClip = proto.clip;
    var origBegin = proto.beginPath;
    var origMove = proto.moveTo;
    var origLine = proto.lineTo;
    var origQuad = proto.quadraticCurveTo;
    var origPattern = proto.createPattern;

    function box(ctx) {
        var b = ctx._pathBox;
        if (!b) b = ctx._pathBox = {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, n: 0};
        return b;
    }
    function add(ctx, x, y) {
        x = +x; y = +y;
        if (x !== x || y !== y) return;
        var b = box(ctx);
        if (x < b.minX) b.minX = x;
        if (y < b.minY) b.minY = y;
        if (x > b.maxX) b.maxX = x;
        if (y > b.maxY) b.maxY = y;
        b.n++;
        // Shape raster cache probes with identity transform. Path numbers are
        // local coordinates; only those belong in the cache bounds.
        if (ctx._trackLocal && ctx._matrix && ctx._matrix[0] === 1 && ctx._matrix[3] === 1 &&
                !ctx._matrix[1] && !ctx._matrix[2] && !ctx._matrix[4] && !ctx._matrix[5]) {
            var lb = ctx._localBox;
            if (!lb) lb = ctx._localBox = {minX: x, minY: y, maxX: x, maxY: y, n: 0};
            if (x < lb.minX) lb.minX = x;
            if (y < lb.minY) lb.minY = y;
            if (x > lb.maxX) lb.maxX = x;
            if (y > lb.maxY) lb.maxY = y;
            lb.n++;
        }
    }
    function invert(m) {
        var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
        var det = a * d - b * c;
        if (!det) return null;
        return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
    }
    function apply(m, x, y) {
        return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    proto.beginPath = function () {
        var b = box(this);
        b.minX = Infinity; b.minY = Infinity; b.maxX = -Infinity; b.maxY = -Infinity; b.n = 0;
        return origBegin.call(this);
    };
    proto.moveTo = function (x, y) { add(this, x, y); return origMove.call(this, x, y); };
    proto.lineTo = function (x, y) { add(this, x, y); return origLine.call(this, x, y); };
    proto.quadraticCurveTo = function (cx, cy, x, y) {
        add(this, cx, cy); add(this, x, y);
        return origQuad.call(this, cx, cy, x, y);
    };
    proto.clip = function () {
        var b = this._pathBox;
        if (b && b.n && this._matrix) {
            this._clipBox = {minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, m: this._matrix.slice()};
        }
        return origClip.apply(this, arguments);
    };
    proto.fillRect = function (x, y, w, h) {
        if (w === 32768 && x === -16384 && h === 32768 && this._clipBox && this._matrix) {
            var clip = this._clipBox;
            var inv = invert(this._matrix);
            if (inv) {
                var cm = clip.m;
                var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                var x0 = clip.minX, y0 = clip.minY, x1 = clip.maxX, y1 = clip.maxY;
                // Corner 0: (x0, y0)
                var d0x = cm[0] * x0 + cm[2] * y0 + cm[4], d0y = cm[1] * x0 + cm[3] * y0 + cm[5];
                var u0x = inv[0] * d0x + inv[2] * d0y + inv[4], u0y = inv[1] * d0x + inv[3] * d0y + inv[5];
                if (u0x < minX) minX = u0x; if (u0x > maxX) maxX = u0x;
                if (u0y < minY) minY = u0y; if (u0y > maxY) maxY = u0y;
                // Corner 1: (x1, y0)
                var d1x = cm[0] * x1 + cm[2] * y0 + cm[4], d1y = cm[1] * x1 + cm[3] * y0 + cm[5];
                var u1x = inv[0] * d1x + inv[2] * d1y + inv[4], u1y = inv[1] * d1x + inv[3] * d1y + inv[5];
                if (u1x < minX) minX = u1x; if (u1x > maxX) maxX = u1x;
                if (u1y < minY) minY = u1y; if (u1y > maxY) maxY = u1y;
                // Corner 2: (x0, y1)
                var d2x = cm[0] * x0 + cm[2] * y1 + cm[4], d2y = cm[1] * x0 + cm[3] * y1 + cm[5];
                var u2x = inv[0] * d2x + inv[2] * d2y + inv[4], u2y = inv[1] * d2x + inv[3] * d2y + inv[5];
                if (u2x < minX) minX = u2x; if (u2x > maxX) maxX = u2x;
                if (u2y < minY) minY = u2y; if (u2y > maxY) maxY = u2y;
                // Corner 3: (x1, y1)
                var d3x = cm[0] * x1 + cm[2] * y1 + cm[4], d3y = cm[1] * x1 + cm[3] * y1 + cm[5];
                var u3x = inv[0] * d3x + inv[2] * d3y + inv[4], u3y = inv[1] * d3x + inv[3] * d3y + inv[5];
                if (u3x < minX) minX = u3x; if (u3x > maxX) maxX = u3x;
                if (u3y < minY) minY = u3y; if (u3y > maxY) maxY = u3y;

                var pad = 2;
                var rw = maxX - minX + pad * 2;
                var rh = maxY - minY + pad * 2;
                if (rw > 0 && rh > 0 && rw < 32768 && rh < 32768)
                    return origFillRect.call(this, minX - pad, minY - pad, rw, rh);
            }
        }
        return origFillRect.call(this, x, y, w, h);
    };
    proto.createPattern = function (image, repetition) {
        if (!image) return origPattern.call(this, image, repetition);
        var wm = this._patCache || (this._patCache = new WeakMap());
        var bag = wm.get(image);
        if (!bag) wm.set(image, bag = {});
        var rep = repetition || "repeat";
        if (bag[rep]) return bag[rep];
        var pat = origPattern.call(this, image, repetition);
        if (pat) bag[rep] = pat;
        return pat;
    };
})();

function drawPlacedGlyphs(ctx, font, color, glyphs) {
    for (var i = 0; i < glyphs.length; i++) {
        var g = glyphs[i];
        ctx.save();
        ctx.transform(g[1], 0, 0, g[1], g[2], g[3]);
        font(ctx, g[0], color);
        ctx.restore();
    }
}

function scaleAdvances(fu, size) {
    var adv = {}, k;
    for (k in fu) if (Object.prototype.hasOwnProperty.call(fu, k)) adv[k] = fu[k] * size;
    return adv;
}
function layoutGlyphs(phrase, advances, size, y, anchor, centered) {
    var width = 0, i, ch, step, x, glyphs = [];
    for (i = 0; i < phrase.length; i++) {
        step = advances[phrase.charAt(i)];
        width += (step == null || step !== step) ? 0 : step;
    }
    x = centered ? anchor - width / 2 : anchor;
    for (i = 0; i < phrase.length; i++) {
        ch = phrase.charAt(i);
        glyphs.push([ch, size, x, y]);
        step = advances[ch];
        x += (step == null || step !== step) ? 0 : step;
    }
    return glyphs;
}
function drawRightGlyphs(ctx, font, color, phrase, fu, size, right, baseline) {
    var adv = scaleAdvances(fu, size);
    var width = 0, i, ch, x, glyphs = [];
    for (i = 0; i < phrase.length; i++) {
        ch = phrase.charAt(i);
        if (!Object.prototype.hasOwnProperty.call(adv, ch)) continue;
        width += adv[ch];
    }
    x = right - width;
    for (i = 0; i < phrase.length; i++) {
        ch = phrase.charAt(i);
        if (!Object.prototype.hasOwnProperty.call(adv, ch)) continue;
        glyphs.push([ch, size, x, baseline]);
        x += adv[ch];
    }
    drawPlacedGlyphs(ctx, font, color, glyphs);
}
function drawCenterGlyphs(ctx, font, color, phrase, fu, size, anchor, baseline) {
    drawPlacedGlyphs(ctx, font, color, layoutGlyphs(phrase, scaleAdvances(fu, size), size, baseline, anchor, true));
}