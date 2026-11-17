declare module 'vtex.render-runtime' {
  interface NavigateOptions {
    page?: string
    params?: Record<string, string>
    to?: string
  }

  interface Runtime {
    navigate: (options: NavigateOptions) => void
    route: { params?: Record<string, string | undefined> }
  }

  export const useRuntime: () => Runtime
}
