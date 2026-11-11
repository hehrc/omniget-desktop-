<script>
  /** Original mascot: “Pip”, a round paper-buddy with a little antenna. */
  let { size = 112, mood = "happy" } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" class="mascot">
  <ellipse cx="60" cy="106" rx="30" ry="5" fill="rgba(20,16,8,.09)" />
  <path d="M60 30V18" stroke="#C4843A" stroke-width="3.4" stroke-linecap="round" />
  <circle cx="60" cy="14" r="5" fill="#FF9500" />
  <rect x="20" y="30" width="80" height="72" rx="26" fill="#FFD79E" />
  <rect x="20" y="30" width="80" height="72" rx="26" fill="url(#pip-grad)" opacity=".65" />
  <defs>
    <linearGradient id="pip-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF" />
      <stop offset="1" stop-color="#FFC670" />
    </linearGradient>
  </defs>
  {#if mood === "happy"}
    <ellipse cx="45" cy="63" rx="3.4" ry="4.4" fill="#3A2A16" />
    <ellipse cx="75" cy="63" rx="3.4" ry="4.4" fill="#3A2A16" />
    <circle cx="46.2" cy="61.6" r="1.1" fill="#fff" />
    <circle cx="76.2" cy="61.6" r="1.1" fill="#fff" />
    <path d="M51 75c2.6 3.4 5.6 5 9 5s6.4-1.6 9-5" stroke="#3A2A16" stroke-width="3" fill="none" stroke-linecap="round" />
  {:else if mood === "thinking"}
    <ellipse cx="45" cy="63" rx="3.4" ry="4.4" fill="#3A2A16" />
    <ellipse cx="75" cy="63" rx="3.4" ry="4.4" fill="#3A2A16" />
    <path d="M52 76h16" stroke="#3A2A16" stroke-width="3" stroke-linecap="round" />
  {:else}
    <path d="M42 60h6M72 60h6" stroke="#3A2A16" stroke-width="3.2" stroke-linecap="round" />
    <path d="M52 76c2.6-2.4 5.6-3.6 8-3.6s5.4 1.2 8 3.6" stroke="#3A2A16" stroke-width="3" fill="none" stroke-linecap="round" />
  {/if}
  <circle cx="34" cy="79" r="6" fill="#FF9F1A" opacity=".38" />
  <circle cx="86" cy="79" r="6" fill="#FF9F1A" opacity=".38" />
</svg>

<style>
  .mascot {
    filter: drop-shadow(0 6px 14px rgba(200, 130, 40, 0.18));
  }
</style>
