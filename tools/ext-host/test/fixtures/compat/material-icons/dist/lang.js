"use strict";var t=require("vscode");var o={glsl:"glsl",hlsl:"hlsl"};function n(t){return t.glsl||t.hlsl}module.exports={language:t.env.language,ids:n(o)};
