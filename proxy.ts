import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { guestRegex, isDevelopmentEnvironment } from "./lib/constants";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /*
   * Playwright starts the dev server and requires a 200 status to
   * begin the tests, so this ensures that the tests can start.
   */
  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Anonymous XHS ingestion should not be redirected to guest auth.
  if (pathname.startsWith("/api/xhs/")) {
    return NextResponse.next();
  }

  // GPT Actions use Bearer API key auth, not session cookies.
  if (pathname.startsWith("/api/gpt/")) {
    return NextResponse.next();
  }

  // Vercel Cron requests use a CRON_SECRET Bearer token, not session cookies.
  if (pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  // 渠道 adapter（Twilio / 企业微信 / 未来其它）走各平台自己的验签，不是会话
  // cookie，别被 guest-auth 重定向掉。路由自身默认关闭
  // （CHANNEL_ADAPTERS_ENABLED），验签在各 adapter 里补。
  if (
    pathname.startsWith("/api/twilio/") ||
    pathname.startsWith("/api/wecom/")
  ) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  if (!token) {
    const redirectUrl = encodeURIComponent(request.url);

    return NextResponse.redirect(
      new URL(`/api/auth/guest?redirectUrl=${redirectUrl}`, request.url)
    );
  }

  const isGuest = guestRegex.test(token?.email ?? "");

  if (token && !isGuest && ["/login", "/register"].includes(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
