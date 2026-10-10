/**
 * Pages shaped like real ones, cut down to the markup that matters: sign-in
 * and sign-up forms from practice sites agents are tested on, which ask for a
 * password and nothing else of a person, and the check pages bot-protection
 * services put in front of a site, which only a person can pass. The browser
 * fixture serves each at `/page/<name>`.
 */
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Sign-in and sign-up pages: looked at like any other, never a check. */
export const SIGN_IN_PAGES: Record<string, string> = {
  // A single-page shop demo: placeholders for names, a password field, a submit input.
  'shop-demo-login': page(
    'Demo shop',
    `<div class="login_logo">Demo shop</div><div class="login-box"><form>
      <input class="input_error form_input" placeholder="Username" type="text" data-test="username" id="user-name" name="user-name" autocorrect="off" autocapitalize="none" value="">
      <input class="input_error form_input" placeholder="Password" type="password" data-test="password" id="password" name="password" autocorrect="off" autocapitalize="none" value="">
      <input type="submit" class="submit-button btn_action" data-test="login-button" id="login-button" name="login-button" value="Login">
    </form></div>
    <div class="login_credentials_wrap"><h4>Accepted usernames are:</h4><p>demo_user</p></div>`,
  ),
  // A labelled login form that posts, with an icon inside its button.
  'labelled-login': page(
    'Practice pages',
    `<h2>Login Page</h2><h4 class="subheader">This is where you can log into the secure area.</h4>
    <form name="login" id="login" action="/authenticate" method="post">
      <label for="username">Username</label><input type="text" name="username" id="username">
      <label for="password">Password</label><input type="password" name="password" id="password">
      <button class="radius" type="submit"><i class="fa fa-2x fa-sign-in"> Login</i></button>
    </form>`,
  ),
  // A bank demo's home page: the sign-in box sits in the side column beside the content.
  'bank-home': page(
    'Demo bank | Welcome | Online Banking',
    `<div id="leftPanel"><h2>Customer Login</h2>
      <form method="post" action="/bank/login.htm" name="login">
        <p><b>Username</b></p><div class="login"><input type="text" class="input" name="username"></div>
        <p><b>Password</b></p><div class="login"><input type="password" class="input" name="password"></div>
        <div class="login"><input type="submit" class="button" value="Log In"></div>
      </form>
      <p><a href="/bank/lookup.htm">Forgot login info?</a></p><p><a href="/bank/register.htm">Register</a></p></div>
    <div id="rightPanel"><h2>ATM Services</h2><ul><li><a href="/services">Withdraw Funds</a></li><li><a href="/services">Transfer Funds</a></li></ul>
      <h2>Online Services</h2><ul><li><a href="/services">Bill Pay</a></li><li><a href="/services">Account History</a></li></ul></div>`,
  ),
  // An HR demo: unlabelled inputs named by placeholders, with a token field the site keeps hidden.
  'hr-login': page(
    'Demo HR',
    `<h5 class="oxd-text oxd-text--h5 hr-login-title">Login</h5>
    <form class="oxd-form" method="post" action="/web/index.php/auth/validate">
      <input name="_token" type="hidden" value="a1b2c3">
      <div><label class="oxd-label">Username</label><input class="oxd-input" name="username" placeholder="Username" autofocus></div>
      <div><label class="oxd-label">Password</label><input class="oxd-input" type="password" name="password" placeholder="Password"></div>
      <button type="submit" class="oxd-button hr-login-button">Login</button>
    </form><p class="hr-login-forgot-header">Forgot your password?</p>`,
  ),
  // A scraping sandbox's login: a form-protection token, labels and a submit input.
  'quotes-login': page(
    'Quotes',
    `<form action="/login" method="post" accept-charset="utf-8">
      <input id="csrf_token" name="csrf_token" type="hidden" value="abcdef">
      <div class="form-group"><label for="username">Username</label><input type="text" class="form-control" id="username" name="username"></div>
      <div class="form-group"><label for="password">Password</label><input type="password" class="form-control" id="password" name="password"></div>
      <input type="submit" value="Login" class="btn btn-primary">
    </form>`,
  ),
  // A store demo's sign-up: two password fields, and the invisible kind of check a footer names.
  'store-register': page(
    'Demo store. Register',
    `<h1>Register</h1><form method="post" action="/register">
      <label for="FirstName">First name:</label><input type="text" id="FirstName" name="FirstName">
      <label for="Email">Email:</label><input type="email" id="Email" name="Email">
      <label for="Password">Password:</label><input type="password" id="Password" name="Password">
      <label for="ConfirmPassword">Confirm password:</label><input type="password" id="ConfirmPassword" name="ConfirmPassword">
      <button type="submit" id="register-button" name="register-button">Register</button>
    </form>
    <iframe title="reCAPTCHA" width="256" height="60" src="https://www.google.com/recaptcha/api2/anchor?k=fixture&amp;size=invisible"></iframe>`,
  ),
};

/** Check pages a bot-protection service shows: only a person can pass them. */
export const CHECK_PAGES: Record<string, string> = {
  // Cloudflare's own interstitial: its options object and the stage its widget sits in.
  'cloudflare-interstitial': page(
    'Just a moment...',
    `<div class="main-wrapper"><h1 class="zone-name-title h1">www.example.com</h1>
      <div id="challenge-stage"></div><noscript>Enable JavaScript and cookies to continue</noscript></div>
    <script>window._cf_chl_opt={cvId:'3',cZone:'www.example.com',cType:'managed'};</script>`,
  ),
  // A Turnstile widget placed in a site's own page.
  turnstile: page(
    'Turnstile demo',
    `<h1>Cloudflare Turnstile demo</h1><form method="post" action="/check">
      <div class="cf-turnstile" data-sitekey="0x4AAAAAAA" style="width:300px;height:65px"></div>
      <button type="submit">Check</button></form>`,
  ),
  // reCAPTCHA's checkbox frame.
  recaptcha: page(
    'reCAPTCHA demo',
    `<form method="post" action="/check"><iframe title="reCAPTCHA" width="304" height="78" src="https://www.google.com/recaptcha/api2/anchor?k=fixture&amp;size=normal"></iframe><button type="submit">Submit</button></form>`,
  ),
  // hCaptcha's checkbox frame.
  hcaptcha: page(
    'hCaptcha demo',
    `<form method="post" action="/check"><iframe title="Widget containing checkbox for hCaptcha security challenge" width="303" height="78" src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&amp;sitekey=fixture"></iframe></form>`,
  ),
  // DataDome's block page: the whole page is its check frame.
  datadome: page(
    'www.example.com',
    `<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=abc&amp;cid=def&amp;referer=https%3A%2F%2Fwww.example.com%2F" width="100%" height="600" style="height:600px" title="DataDome CAPTCHA"></iframe>`,
  ),
  // A travel site's own check page: reCAPTCHA drawn by its script a moment after the page loads.
  // The provider's script tag is kept as the page has it, typed so that the browser leaves it
  // unfetched in a test that reaches no outside host; the timer below draws what it would.
  'late-drawn-check': page(
    'Please verify that you are a real user',
    `<script type="text/x-unfetched" src="https://www.google.com/recaptcha/enterprise.js?onload=setupCaptcha&amp;render=explicit" async defer></script>
    <div id="outer"><h1 id="title">Please confirm that you are a real user.</h1><div id="captcha"></div></div>
    <script>setTimeout(() => { const frame = document.createElement('iframe'); frame.title = 'reCAPTCHA'; frame.width = '304'; frame.height = '78'; frame.src = 'https://www.google.com/recaptcha/enterprise/anchor?k=fixture&size=normal'; document.getElementById('captcha').appendChild(frame); }, 1200);</script>`,
  ),
  // PerimeterX's press-and-hold box.
  'perimeterx-hold': page(
    'Access to this page has been denied',
    `<h1>Please verify you are a human</h1><p>Press &amp; Hold to confirm you are a human (and not a bot).</p>
    <div id="px-captcha" style="width:310px;height:100px"></div>`,
  ),
};
