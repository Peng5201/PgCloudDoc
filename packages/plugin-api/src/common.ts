/** 所有注册/监听的统一释放句柄。宿主停用插件时逐个 dispose */
export interface Disposable {
  dispose(): void;
}
