const fs = require('fs')
const path = require('path')

const filesToPatch = [
  path.join(__dirname, '../node_modules/html2canvas/dist/html2canvas.js'),
  path.join(__dirname, '../node_modules/html2canvas/dist/html2canvas.esm.js'),
  path.join(__dirname, '../node_modules/html2canvas/dist/lib/css/types/color.js')
]

const helperFunction = `
function parseUnsupportedColor(value, packFn) {
  try {
    var str = value.name + '(' + value.values.map(function(t) {
      if (t.type === 17) return String(t.number);
      if (t.type === 16) return t.number + '%';
      if (t.type === 15) return t.number + t.unit;
      if (t.type === 20) return t.value;
      if (t.type === 13) return String.fromCharCode(t.value);
      if (t.type === 14) return ' ';
      if (t.value !== undefined) return String(t.value);
      return '';
    }).join('') + ')';

    if (typeof document !== 'undefined') {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      var ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000000';
        ctx.fillStyle = str;
        var res = ctx.fillStyle;
        if (res && res.startsWith('#')) {
          var r = parseInt(res.slice(1, 3), 16);
          var g = parseInt(res.slice(3, 5), 16);
          var b = parseInt(res.slice(5, 7), 16);
          var a = res.length === 9 ? parseInt(res.slice(7, 9), 16) / 255 : 1;
          return packFn(r, g, b, a);
        }
        var m = res && res.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
        if (m) {
          return packFn(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4] !== undefined ? parseFloat(m[4]) : 1);
        }
      }
    }

    if (value.name === 'oklch') {
      var nums = value.values.filter(function(t) { return t.type === 17 || t.type === 16; });
      if (nums.length >= 3) {
        var L = nums[0].type === 16 ? nums[0].number / 100 : nums[0].number;
        var C = nums[1].number;
        var H = nums[2].number;
        var al = nums[3] ? (nums[3].type === 16 ? nums[3].number / 100 : nums[3].number) : 1;
        var hRad = (H * Math.PI) / 180;
        var a_ = C * Math.cos(hRad);
        var b_ = C * Math.sin(hRad);
        var l_ = L + 0.3963377774 * a_ + 0.2158037573 * b_;
        var m_ = L - 0.1055613458 * a_ - 0.0638541728 * b_;
        var s_ = L - 0.0894841775 * a_ - 1.291485548 * b_;
        var l3 = l_ * l_ * l_;
        var m3 = m_ * m_ * m_;
        var s3 = s_ * s_ * s_;
        var rLin = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
        var gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
        var bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
        var toG = function(v) {
          var cl = Math.max(0, Math.min(1, v));
          return cl <= 0.0031308 ? 12.92 * cl : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
        };
        return packFn(Math.round(toG(rLin) * 255), Math.round(toG(gLin) * 255), Math.round(toG(bLin) * 255), al);
      }
    }
  } catch(e) {}
  return packFn(0, 0, 0, 1);
}
`

let patchedAny = false

filesToPatch.forEach(file => {
  if (!fs.existsSync(file)) return
  let content = fs.readFileSync(file, 'utf8')

  if (content.includes('parseUnsupportedColor')) {
    console.log('[patch-html2canvas] Already patched:', path.basename(file))
    return
  }

  const target = `throw new Error("Attempting to parse an unsupported color function \\"" + value.name + "\\"");`
  const targetAlt = `throw new Error('Attempting to parse an unsupported color function "' + value.name + '"');`

  if (content.includes(target) || content.includes(targetAlt)) {
    const isEsm = file.endsWith('.esm.js')
    const packRef = isEsm ? 'pack' : (content.includes('exports.pack') ? 'exports.pack' : 'pack')
    const replacement = `return parseUnsupportedColor(value, ${packRef});`

    if (content.includes(target)) {
      content = content.replace(target, replacement)
    } else {
      content = content.replace(targetAlt, replacement)
    }

    content = helperFunction + '\n' + content
    fs.writeFileSync(file, content, 'utf8')
    console.log('[patch-html2canvas] Successfully patched:', path.basename(file))
    patchedAny = true
  }
})

// Clean vite cache if files were patched
const viteCacheDir = path.join(__dirname, '../node_modules/.vite')
if (fs.existsSync(viteCacheDir)) {
  fs.rmSync(viteCacheDir, { recursive: true, force: true })
  console.log('[patch-html2canvas] Cleared .vite cache directory')
}
const localViteCache = path.join(__dirname, '../.vite')
if (fs.existsSync(localViteCache)) {
  fs.rmSync(localViteCache, { recursive: true, force: true })
  console.log('[patch-html2canvas] Cleared local .vite cache directory')
}
