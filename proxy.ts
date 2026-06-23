

  /** 油猴匿名上报：不做登录重定向，避免 POST 被 307 到 guest 后变成 405 */
  if (pathname.startsWith("/api/xhs/")) {
    return NextResponse.next();
  }