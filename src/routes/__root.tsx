import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import TanStackQueryProvider from '../integrations/tanstack-query/root-provider'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

import type { TRPCRouter } from '#/integrations/trpc/router'
import type { TRPCOptionsProxy } from '@trpc/tanstack-react-query'

interface MyRouterContext {
  queryClient: QueryClient

  trpc: TRPCOptionsProxy<TRPCRouter>
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'TouchGrass.city',
      },
      {
        name: 'theme-color',
        content: '#0f2c1b',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'manifest',
        href: '/site.webmanifest?v=touchgrass-1',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32x32.png?v=touchgrass-1',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/favicon-16x16.png?v=touchgrass-1',
      },
      {
        rel: 'shortcut icon',
        href: '/favicon.ico?v=touchgrass-1',
      },
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png?v=touchgrass-1',
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          defer
          data-domain="touchgrass.city"
          src="https://tic.nrby.xyz/js/script.js"
        />
      </head>
      <body>
        <TanStackQueryProvider>
          {children}
          <TanStackDevtools
            config={{
              position: 'bottom-right',
            }}
            plugins={[
              {
                name: 'Tanstack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
              TanStackQueryDevtools,
            ]}
          />
        </TanStackQueryProvider>
        <Scripts />
      </body>
    </html>
  )
}
