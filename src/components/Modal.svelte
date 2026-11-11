<script>
  import Icon from "./Icon.svelte";

  let {
    open = false,
    title = "",
    subtitle = "",
    size = "md",
    onClose = () => {},
    children,
    footer,
  } = $props();

  let panel = $state(null);

  function onKey(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  $effect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const timer = setTimeout(() => {
      const focusable = panel?.querySelector(
        "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])",
      );
      focusable?.focus();
    }, 60);
    const root = document.documentElement;
    root.style.overflow = "hidden";
    return () => {
      clearTimeout(timer);
      root.style.overflow = "";
      if (previous instanceof HTMLElement) previous.focus?.();
    };
  });
</script>

<svelte:window onkeydown={open ? onKey : undefined} />

{#if open}
  <div
    class="dialog-backdrop"
    role="presentation"
    onmousedown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <div
      class="dialog {size === 'lg' ? 'dialog-lg' : ''}"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      bind:this={panel}
    >
      <div class="dialog-header">
        <div class="row row-between" style="align-items: flex-start; gap: 12px">
          <div class="stack stack-1">
            <h3 class="section-title">{title}</h3>
            {#if subtitle}<p class="muted" style="font-size: 11.5px">{subtitle}</p>{/if}
          </div>
          <button class="btn btn-ghost btn-icon btn-sm" onclick={onClose} aria-label="Close dialog">
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>
      <div class="dialog-body">
        {@render children?.()}
      </div>
      {#if footer}
        <div class="dialog-footer">{@render footer()}</div>
      {/if}
    </div>
  </div>
{/if}
