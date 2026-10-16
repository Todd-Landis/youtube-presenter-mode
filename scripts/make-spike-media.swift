// Test media for the move-video spike (spike/move-video): a progressive MP4
// for a plain <video src>, and a fragmented MP4 that the page feeds through
// MediaSource. Each frame shows the playback time in large digits over a
// moving colour field, with a short beep every second, so a stall, a black
// picture or a jump is obvious.
//
// swift scripts/make-spike-media.swift <output-dir>
import AVFoundation
import CoreText
import Foundation
import UniformTypeIdentifiers

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".", isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let seconds = 150
let fps: Int32 = 30
let width = 960, height = 540
let sampleRate = 44100

final class SegmentCollector: NSObject, AVAssetWriterDelegate {
  var data = Data()
  var count = 0
  func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data,
                   segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
    data.append(segmentData)
    count += 1
  }
}

func drawFrame(_ pb: CVPixelBuffer, frame: Int, label: String, hueBase: CGFloat) {
  CVPixelBufferLockBaseAddress(pb, [])
  defer { CVPixelBufferUnlockBaseAddress(pb, []) }
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
                      bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  let t = Double(frame) / Double(fps)
  let hue = (hueBase + CGFloat(t / 40).truncatingRemainder(dividingBy: 1)).truncatingRemainder(dividingBy: 1)
  ctx.setFillColor(CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: hsv(hue, 0.55, 0.45))!)
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  // A bar sweeping across once a second: freezes are visible at a glance.
  let x = CGFloat(t.truncatingRemainder(dividingBy: 1)) * CGFloat(width - 60)
  ctx.setFillColor(CGColor(gray: 1, alpha: 0.85))
  ctx.fill(CGRect(x: x, y: 40, width: 60, height: 24))
  let s = Int(t)
  let stamp = String(format: "%d:%02d.%d", s / 60, s % 60, Int(t * 10) % 10)
  text(ctx, stamp, size: 150, y: CGFloat(height) / 2 - 40)
  text(ctx, label, size: 44, y: CGFloat(height) - 110)
}

func text(_ ctx: CGContext, _ s: String, size: CGFloat, y: CGFloat) {
  let font = CTFontCreateWithName("Menlo-Bold" as CFString, size, nil)
  let attrs: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1),
  ]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
  let w = CTLineGetTypographicBounds(line, nil, nil, nil)
  ctx.textPosition = CGPoint(x: (CGFloat(width) - CGFloat(w)) / 2, y: y)
  CTLineDraw(line, ctx)
}

func hsv(_ h: CGFloat, _ s: CGFloat, _ v: CGFloat) -> [CGFloat] {
  let i = Int(h * 6), f = h * 6 - CGFloat(i)
  let p = v * (1 - s), q = v * (1 - f * s), u = v * (1 - (1 - f) * s)
  let rgb: [CGFloat]
  switch i % 6 {
  case 0: rgb = [v, u, p]
  case 1: rgb = [q, v, p]
  case 2: rgb = [p, v, u]
  case 3: rgb = [p, q, v]
  case 4: rgb = [u, p, v]
  default: rgb = [v, p, q]
  }
  return rgb + [1]
}

// One second of 16-bit stereo: a 100 ms 880 Hz beep, then silence.
func audioBuffer(second: Int, format: CMAudioFormatDescription) -> CMSampleBuffer {
  var pcm = [Int16](repeating: 0, count: sampleRate * 2)
  for i in 0..<(sampleRate / 10) {
    let v = Int16(sin(Double(i) * 2 * .pi * 880 / Double(sampleRate)) * 6000)
    pcm[i * 2] = v
    pcm[i * 2 + 1] = v
  }
  let bytes = pcm.count * 2
  var block: CMBlockBuffer?
  CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                                     customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
  pcm.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes) }
  var sb: CMSampleBuffer?
  CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format,
                                                       sampleCount: sampleRate, presentationTimeStamp: CMTime(value: CMTimeValue(second * sampleRate), timescale: CMTimeScale(sampleRate)),
                                                       packetDescriptions: nil, sampleBufferOut: &sb)
  return sb!
}

func write(_ writer: AVAssetWriter, label: String, hueBase: CGFloat) {
  let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
      AVVideoAverageBitRateKey: 1_200_000,
      AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
      AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
      AVVideoAllowFrameReorderingKey: false,
    ],
  ])
  let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: sampleRate,
    AVNumberOfChannelsKey: 2,
    AVEncoderBitRateKey: 128_000,
  ])
  video.expectsMediaDataInRealTime = false
  audio.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
  ])
  writer.add(video)
  writer.add(audio)
  guard writer.startWriting() else { fatalError("startWriting: \(String(describing: writer.error))") }
  writer.startSession(atSourceTime: .zero)

  var asbd = AudioStreamBasicDescription(mSampleRate: Float64(sampleRate), mFormatID: kAudioFormatLinearPCM,
                                         mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                         mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2,
                                         mBitsPerChannel: 16, mReserved: 0)
  var afmt: CMAudioFormatDescription?
  CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                 magicCookie: nil, extensions: nil, formatDescriptionOut: &afmt)

  let group = DispatchGroup()
  var frame = 0
  group.enter()
  video.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
    while video.isReadyForMoreMediaData {
      if frame >= seconds * Int(fps) {
        video.markAsFinished()
        group.leave()
        return
      }
      var pb: CVPixelBuffer?
      CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
      drawFrame(pb!, frame: frame, label: label, hueBase: hueBase)
      adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps))
      frame += 1
    }
  }
  var second = 0
  group.enter()
  audio.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
    while audio.isReadyForMoreMediaData {
      if second >= seconds {
        audio.markAsFinished()
        group.leave()
        return
      }
      audio.append(audioBuffer(second: second, format: afmt!))
      second += 1
    }
  }
  group.wait()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  if writer.status != .completed { fatalError("\(label): \(String(describing: writer.error))") }
}

// Progressive MP4, moov first so playback starts before the download ends.
let plainURL = outDir.appendingPathComponent("clip.mp4")
try? FileManager.default.removeItem(at: plainURL)
let plain = try AVAssetWriter(outputURL: plainURL, fileType: .mp4)
plain.shouldOptimizeForNetworkUse = true
write(plain, label: "PLAIN MP4", hueBase: 0.58)
print("wrote \(plainURL.path)")

// Fragmented MP4 (init segment + 2 s media segments, concatenated), the
// byte stream a MediaSource player appends.
let collector = SegmentCollector()
let frag = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
frag.outputFileTypeProfile = .mpeg4AppleHLS
frag.preferredOutputSegmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
frag.initialSegmentStartTime = .zero
frag.delegate = collector
write(frag, label: "MSE", hueBase: 0.05)
let fragURL = outDir.appendingPathComponent("clip-frag.mp4")
try collector.data.write(to: fragURL)
print("wrote \(fragURL.path) (\(collector.count) segments)")
