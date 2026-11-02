import Foundation
import FBControlCore
import FBSimulatorControl
@main struct AXWorker {
 @MainActor static func main() async throws {
  let logger = FBControlCoreLoggerFactory.systemLoggerWriting(toStderr: true, withDebugLogging: false)
  try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
  try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
  let cfg = FBSimulatorControlConfiguration(deviceSetPath: nil, logger: logger, reporter: nil)
  let control = try FBSimulatorControl.withConfiguration(cfg)
  guard let target = control.set.allSimulators.first(where: {$0.udid == CommandLine.arguments[1]}) else {return}
  while let _ = readLine() {
   do {
    let node = try await target.accessibilityElementForFrontmostApplication()
    defer {node.close()}
    let response = try node.serialize(with: FBAccessibilityRequestOptions(nestedFormat:true, keys:[.label,.frame,.frameDict,.value,.uniqueID,.type,.enabled,.role,.subrole,.pid,.focused],enableProfiling:false))
    let data = try JSONSerialization.data(withJSONObject:response.elements, options:[.sortedKeys])
    print(String(decoding:data,as:UTF8.self));fflush(stdout)
   } catch {let d = try! JSONSerialization.data(withJSONObject:["error":String(describing:error)]);print(String(decoding:d,as:UTF8.self));fflush(stdout)}
  }
 }
}
