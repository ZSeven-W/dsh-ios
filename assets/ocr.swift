// dsh-ios Vision OCR helper.
//
// Compiled on first use by src/ocr-backend.ts:
//     swiftc -O ocr.swift -o ocr
//
// Reads one PNG path from argv, runs VNRecognizeTextRequest (.accurate,
// zh-Hans + en-US, language correction on), and prints a JSON object:
//
//     {"count": N, "items": [{"text": "...", "confidence": 0.87, "x": ..., "y": ..., "w": ..., "h": ...}]}
//
// Boxes are IMAGE PIXELS with the origin at the TOP-LEFT (Vision reports
// normalized, bottom-left origin coordinates; this helper converts them).
// Only the bounding box of the best candidate is returned per observation.

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("dsh-ios ocr: usage: ocr <image.png>\n".utf8))
    exit(2)
}

let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("dsh-ios ocr: could not read image at \(path)\n".utf8))
    exit(1)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([req])
} catch {
    FileHandle.standardError.write(Data("dsh-ios ocr: Vision failed: \(error)\n".utf8))
    exit(1)
}

let width = Double(cg.width)
let height = Double(cg.height)
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox  // normalized, origin bottom-left
    out.append([
        "text": top.string,
        "confidence": round(Double(top.confidence) * 100) / 100,
        // Convert to image pixels with the origin at the top-left.
        "x": Int(b.minX * width),
        "y": Int((1 - b.maxY) * height),
        "w": Int(b.width * width),
        "h": Int(b.height * height),
    ])
}

let payload: [String: Any] = ["count": out.count, "items": out]
let data = try JSONSerialization.data(withJSONObject: payload, options: [])
print(String(data: data, encoding: .utf8)!)
