export {}

declare module 'vue' {
  export interface GlobalComponents {
    ElTable: typeof import('element-plus/es')['ElTable']
    ElTableColumn: typeof import('element-plus/es')['ElTableColumn']
  }
}
