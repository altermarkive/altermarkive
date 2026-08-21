/// <reference types="vite/client" />
/// <reference types="vite-plugin-vue-layouts-next/client" />
/// <reference types="dom-speech-recognition" />

interface NavigatorUABrand {
  brand: string
  version: string
}

interface Navigator {
  userAgentData?: { brands: NavigatorUABrand[] }
}
