<script>
  let { size = 28, showWord = true, wordSize = 16 } = $props();
</script>

<span class="logo" class:with-word={showWord}>
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="omniget-mark" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#FFB13D" />
        <stop offset="1" stop-color="#F08200" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="17" fill="url(#omniget-mark)" />
    <path
      d="M32 13v24m0 0 10-10M32 37 22 27"
      fill="none"
      stroke="#231502"
      stroke-width="6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M17 44v4.5a4 4 0 0 0 4 4h22a4 4 0 0 0 4-4V44"
      fill="none"
      stroke="#231502"
      stroke-width="6"
      stroke-linecap="round"
    />
  </svg>
  {#if showWord}
    <span class="logo-word" style="font-size: {wordSize}px">OmniGet</span>
  {/if}
</span>

<style>
  .logo {
    display: inline-flex;
    align-items: center;
    gap: 9px;
  }
  .logo svg {
    border-radius: 8px;
    box-shadow: 0 1px 2px rgba(20, 16, 8, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.4);
    flex: 0 0 auto;
  }
  .logo-word {
    font-family: var(--font-display);
    font-weight: 680;
    letter-spacing: -0.03em;
    color: var(--secondary);
    line-height: 1;
  }
</style>
