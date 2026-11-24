/**
 * DMG 安装界面的背景图（#417）
 *
 * 为什么要它：DMG 打开后原本只有两个图标和一句「拖过去」的默认留白，而这一屏是用户与
 * 「未签名应用」的第一次照面。真正会卡住人的不是拖，是拖完之后双击被系统拦住——网站
 * 「安装与启动」那一节写了右键打开，但不是所有人装之前都读文档，所以把这两句挪进包内那一屏。
 *
 * 跑法（在仓库根目录）：`osascript -l JavaScript scripts/make-dmg-background.js`
 * 产出：`src/assets/dmg/background.png`（540×380，逻辑尺寸）与 `background@2x.png`（1080×760）。
 * 这两份是构建产物之外的静态资产，直接进仓库；electron-builder 的 `dmg.background` 指向前者，
 * dmg-builder 见到同名 `@2x` 就自己用 `tiffutil -cathidpicheck` 合成双分辨率 TIFF。
 *
 * 为什么用 osascript 而不是画一个现成的 PNG 提交：文案与图标位置是一套有约束的几何
 * （图标的中心点由 `dmg.contents` 决定，文字必须避开它们），改一句话应该改代码里那一行，
 * 而不是在图像编辑器里重新排版。坐标全按 540×380 的逻辑尺寸写，@2x 只是同一次绘制放大两倍。
 */
ObjC.import('Foundation')
ObjC.import('AppKit')

/** 逻辑尺寸：与 dmg.contents 的坐标系同一把尺 */
const W = 540
const H = 380
/** 图标中心点，必须与 electron-builder.cjs 里 dmg.contents 的 x/y 一致 */
const ICON_Y = 150
const APP_ICON_X = 135
const APPS_ICON_X = 405
const ICON_SIZE = 80

const INK = [0x11, 0x18, 0x27]
const MUTED = [0x6b, 0x72, 0x80]
const BRAND = [0x1b, 0x55, 0xf5]
const CARD = [0xf7, 0xf9, 0xfc]
const CARD_EDGE = [0xe6, 0xeb, 0xf2]

function color(rgb) {
  return $.NSColor.colorWithDeviceRedGreenBlueAlpha(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1)
}

/** PingFang 在部分 macOS 上不存在（本机可核），拿不到就退回系统字体：中文靠级联，不会出豆腐块 */
function font(name, size) {
  const f = $.NSFont.fontWithNameSize(name, size)
  return f.isNil() ? $.NSFont.systemFontOfSize(size) : f
}

/** 设计坐标以左上角为原点，AppKit 以左下角为原点，这里统一换算 */
function rect(x, top, width, height) {
  return $.NSMakeRect(x, H - top - height, width, height)
}

function attributes(fnt, ink, align) {
  const style = $.NSMutableParagraphStyle.alloc.init
  style.alignment = align === 'center' ? 1 : 0
  const attrs = $.NSMutableDictionary.alloc.init
  attrs.setObjectForKey(fnt, 'NSFont')
  attrs.setObjectForKey(color(ink), 'NSColor')
  attrs.setObjectForKey(style, 'NSParagraphStyle')
  return attrs
}

/** 画一行字：y 是行框顶边；居中时按整幅宽排，左对齐时从 x 排到右边界 */
function drawText(text, { x = 0, y, size = 12, name = 'PingFang SC', ink = INK, align = 'left' }) {
  const fnt = font(name, size)
  const attrs = attributes(fnt, ink, align)
  const box = align === 'center' ? rect(0, y, W, size * 1.5) : rect(x, y, W - x, size * 1.5)
  $(text).drawInRectWithAttributes(box, attrs)
  return fnt
}

/** 同一行里换色（灰色标签 + 品牌色网址），第二段接着第一段的实测宽度画 */
function drawRuns(runs, { x, y }) {
  let left = x
  for (const run of runs) {
    const fnt = font(run.name || 'PingFang SC', run.size)
    const attrs = attributes(fnt, run.ink, 'left')
    const width = $(run.text).sizeWithAttributes(attrs).width
    $(run.text).drawInRectWithAttributes(rect(left, y, width + 4, run.size * 1.5), attrs)
    left += width
  }
}

function drawArrow() {
  const mid = H - ICON_Y
  const from = APP_ICON_X + ICON_SIZE / 2 + 26
  const to = APPS_ICON_X - ICON_SIZE / 2 - 26
  const line = $.NSBezierPath.bezierPath
  line.moveToPoint($.NSMakePoint(from, mid))
  line.lineToPoint($.NSMakePoint(to - 9, mid))
  line.setLineWidth(2.5)
  line.setLineCapStyle(1)
  color(BRAND).setStroke
  line.stroke
  const head = $.NSBezierPath.bezierPath
  head.moveToPoint($.NSMakePoint(to, mid))
  head.lineToPoint($.NSMakePoint(to - 11, mid + 6.5))
  head.lineToPoint($.NSMakePoint(to - 11, mid - 6.5))
  head.closePath
  color(BRAND).setFill
  head.fill
}

function drawCard(top, height) {
  const path = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect(36, top, W - 72, height), 10, 10)
  color(CARD).setFill
  path.fill
  path.setLineWidth(1)
  color(CARD_EDGE).setStroke
  path.stroke
}

function render(pxW, pxH, out) {
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, pxW, pxH, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
  )
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep)
  $.NSGraphicsContext.saveGraphicsState
  $.NSGraphicsContext.setCurrentContext(ctx)
  const scale = pxW / W
  // NSAffineTransform 的缩放方法在 JXA 桥里没暴露，直接改 CGContext 的 CTM
  $.CGContextScaleCTM($.NSGraphicsContext.currentContext.CGContext, scale, scale)
  color([0xff, 0xff, 0xff]).set
  $.NSBezierPath.fillRect($.NSMakeRect(0, 0, W, H))

  drawText('① 把应用拖进「应用程序」', { y: 30, size: 14, name: 'PingFang SC Semibold', align: 'center' })
  drawArrow()

  drawCard(232, 118)
  drawText('② 首次打开：右键 App 图标 →「打开」', { x: 56, y: 248, size: 12.5, name: 'PingFang SC Medium' })
  drawText('应用未做签名，这一步每台 Mac 只需一次', { x: 56, y: 274, size: 11.5, ink: MUTED })
  drawRuns(
    [
      { text: '完整说明 ', size: 11.5, ink: MUTED },
      { text: 'vvscribe.com/docs#install', size: 11.5, ink: BRAND },
    ],
    { x: 56, y: 304 }
  )

  $.NSGraphicsContext.restoreGraphicsState
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
  if (!data.writeToFileAtomically(out, true)) throw new Error('写不出 ' + out)
  return out
}

function run() {
  const dir = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath) + '/src/assets/dmg'
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $())
  return [render(W, H, dir + '/background.png'), render(W * 2, H * 2, dir + '/background@2x.png')].join('\n')
}
