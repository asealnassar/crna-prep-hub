import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import ClientProviders from '@/components/ClientProviders'
import Script from 'next/script'
import InstallPWA from '@/components/InstallPWA'  // ADD THIS LINE        
import SiteAnalytics from '@/components/SiteAnalytics'
import ConsentBanner from '@/components/ConsentBanner'
const inter = Inter({ subsets: ['latin'] })
            
export const metadata: Metadata = {
  title: 'CRNA Prep Hub - Your Complete CRNA School Application Resource',
  description: 'Search CRNA programs, filter by requirements, and practice mock interviews',
}
        
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        {/*
          CONSENT BOOTSTRAP. Runs before either advertising tag, and is the
          only reason this file changed: it reads the consent cookie and puts
          Google Consent Mode v2 into a DENIED default, so the tag below can
          load exactly as it always has without being allowed to use storage
          until somebody has agreed. The tag id and the events it sends are
          untouched, and Google's own modelling covers the gap — which is why
          this is better for the campaigns than refusing to load the tag.

          It also decides whether the TikTok pixel further down must hold its
          page event back. Held is not lost: grantConsent() releases it, once.
        */}
        <Script id="consent-bootstrap" strategy="beforeInteractive">
          {`
            (function () {
              var m = document.cookie.match(/(?:^|; )cph_consent=([^;]*)/);
              var v = m ? decodeURIComponent(m[1]) : '';
              var parts = /^v1:([01]):([01])$/.exec(v);
              var analytics = parts ? parts[1] === '1' : false;
              var advertising = parts ? parts[2] === '1' : false;

              window.__cphAdvertisingGranted = advertising;
              window.__cphConsent = parts
                ? { version: 1, analytics: analytics ? 'granted' : 'denied',
                    advertising: advertising ? 'granted' : 'denied' }
                : null;

              window.dataLayer = window.dataLayer || [];
              function gtag(){ dataLayer.push(arguments); }
              gtag('consent', 'default', {
                ad_storage: advertising ? 'granted' : 'denied',
                ad_user_data: advertising ? 'granted' : 'denied',
                ad_personalization: advertising ? 'granted' : 'denied',
                analytics_storage: analytics ? 'granted' : 'denied',
                wait_for_update: 500
              });
            })();
          `}
        </Script>

        {/* Google Ads */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=AW-17939352347"
          strategy="lazyOnload"
        />
        <Script id="google-ads" strategy="lazyOnload">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'AW-17939352347');
          `}
        </Script>

        {/* TikTok Pixel */}
        <Script id="tiktok-pixel" strategy="lazyOnload">
          {`
            !function (w, d, t) {
              w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
              ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};
              for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);
              ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};
              ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=i+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
              // Hold everything back until consent exists. The page event is
              // QUEUED, not dropped: grantConsent() releases it exactly once,
              // so no conversion is duplicated and none is lost for a visitor
              // who agrees. Where consent is already granted, or where the
              // visitor's region does not require asking first, this is a
              // no-op and the pixel behaves exactly as it did before.
              if (!window.__cphAdvertisingGranted) { ttq.holdConsent(); }
              ttq.load('D6KMK3BC77U3SAC89I80');
              ttq.page();
            }(window, document, 'ttq');
          `}
       </Script>

        {/* PWA Manifest */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#7c3aed" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="CRNA Prep" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
<body className={inter.className}>
        <ClientProviders>{children}</ClientProviders>
        <InstallPWA />  {/* ADD THIS LINE */}
        {/* First-party page views. Renders nothing, and stays dormant unless
            NEXT_PUBLIC_ANALYTICS_TRACKING is 'on'. The Google Ads tag and the
            TikTok pixel above are untouched and keep reporting as before. */}
        <SiteAnalytics />
        <ConsentBanner />
      </body>
    </html>
  )
}
