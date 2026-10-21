import Capacitor

// Capacitor 7 只自动注册 pod 形式的插件（capacitor.config.json 的 packageClassList）。
// RealtimeAsr / RealtimeTranslate 直接编进 App target、不是 pod，故在此手动注册。
class MainViewController: CAPBridgeViewController {
  override open func capacitorDidLoad() {
    bridge?.registerPluginInstance(RealtimeAsrPlugin())
    bridge?.registerPluginInstance(RayNeoPlugin())
    // RealtimeTranslate 类在所有版本都可编译，方法内部用 #available(iOS 18) 自行降级
    // （iOS<18 调用返回 unavailable，不崩溃），故无条件注册。
    bridge?.registerPluginInstance(RealtimeTranslatePlugin())
  }
}
