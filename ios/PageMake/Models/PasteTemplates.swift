import Foundation

/// 粘贴代码的快捷模板（选中即填充 HTML/CSS/JS）
struct PasteTemplate: Identifiable {
    let id: String
    let nameKey: String
    let html: String
    let css: String
    let js: String
}

enum PasteTemplates {
    static let all: [PasteTemplate] = [profile, landing, blog]

    // MARK: - 个人主页

    static let profile = PasteTemplate(
        id: "profile",
        nameKey: "template_profile",
        html: """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>我的主页</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="card">
    <div class="avatar">😀</div>
    <h1>你的名字</h1>
    <p class="bio">一句话介绍自己</p>
    <div class="links">
      <a href="#">博客</a>
      <a href="#">GitHub</a>
      <a href="#">邮箱</a>
    </div>
  </main>
</body>
</html>
""",
        css: """
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: linear-gradient(160deg, #1e3a8a, #2563eb);
  font-family: -apple-system, "PingFang SC", sans-serif; color: #fff;
}
.card {
  width: min(420px, 88vw); padding: 32px; border-radius: 24px;
  background: rgba(255,255,255,.12); backdrop-filter: blur(12px);
  text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.3);
}
.avatar { font-size: 64px; }
h1 { margin: 12px 0 4px; font-size: 26px; }
.bio { margin: 0 0 20px; opacity: .85; }
.links { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.links a {
  color: #fff; text-decoration: none; padding: 8px 16px;
  border-radius: 999px; background: rgba(255,255,255,.18);
}
.links a:hover { background: rgba(255,255,255,.3); }
""",
        js: """
document.querySelectorAll('.links a').forEach((a) => {
  a.addEventListener('click', (e) => {
    if (a.getAttribute('href') === '#') e.preventDefault();
  });
});
"""
    )

    // MARK: - 产品落地页

    static let landing = PasteTemplate(
        id: "landing",
        nameKey: "template_landing",
        html: """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>产品名称</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <section class="hero">
    <span class="tag">全新上线</span>
    <h1>让想法<br>一分钟上线</h1>
    <p class="sub">把 HTML / CSS / JS 粘贴进来，立刻得到公开链接。</p>
    <button id="cta">立即体验</button>
  </section>
</body>
</html>
""",
        css: """
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "PingFang SC", sans-serif; background: #f8fafc; color: #0f172a; }
.hero { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 8vw; }
.tag {
  display: inline-block; width: fit-content; padding: 6px 14px; border-radius: 999px;
  background: #dbeafe; color: #1d4ed8; font-size: 14px; margin-bottom: 18px;
}
h1 { font-size: clamp(36px, 7vw, 64px); line-height: 1.1; margin: 0 0 16px; }
.sub { font-size: clamp(16px, 2.4vw, 20px); color: #475569; max-width: 560px; margin: 0 0 28px; }
button {
  width: fit-content; padding: 14px 32px; border: 0; border-radius: 12px;
  background: #2563eb; color: #fff; font-size: 17px; cursor: pointer;
  box-shadow: 0 10px 24px rgba(37,99,235,.35);
}
button:hover { background: #1d4ed8; }
""",
        js: """
document.getElementById('cta')?.addEventListener('click', () => {
  alert('按钮点击成功，把这里换成你的动作');
});
"""
    )

    // MARK: - 博客文章

    static let blog = PasteTemplate(
        id: "blog",
        nameKey: "template_blog",
        html: """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>文章标题</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <article>
    <header>
      <h1>文章标题</h1>
      <p class="meta">2026 年 10 月 · 5 分钟阅读</p>
    </header>
    <p>这里是第一段正文。把内容替换成你自己的文字。</p>
    <h2>小标题</h2>
    <p>第二段正文。支持 <strong>加粗</strong>、<em>斜体</em> 和 <a href="#">链接</a>。</p>
    <blockquote>引用一段话，增加阅读节奏。</blockquote>
  </article>
</body>
</html>
""",
        css: """
body {
  margin: 0; padding: 48px 20px; background: #fff; color: #1f2937;
  font-family: Georgia, "Songti SC", serif;
}
article { max-width: 680px; margin: 0 auto; line-height: 1.9; font-size: 18px; }
h1 { font-size: 34px; line-height: 1.3; margin: 0 0 8px; }
.meta { color: #9ca3af; font-size: 14px; margin: 0 0 32px; }
h2 { margin-top: 36px; font-size: 24px; }
blockquote {
  margin: 24px 0; padding: 12px 20px; border-left: 4px solid #d1d5db;
  color: #4b5563; background: #f9fafb;
}
a { color: #2563eb; }
""",
        js: ""
    )
}
