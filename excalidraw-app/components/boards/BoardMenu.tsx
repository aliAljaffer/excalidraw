import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import React from "react";

/**
 * The board menus portal into the dialog root, so a menu opened on a card in
 * the scrolling grid is never clipped by it and keeps the editor's theme.
 */
export const BoardMenu = ({
  portalRoot,
  onCloseAutoFocus,
  children,
}: {
  portalRoot: HTMLElement | null;
  onCloseAutoFocus?: (event: Event) => void;
  children: React.ReactNode;
}) => {
  if (!portalRoot) {
    return null;
  }
  return (
    <DropdownMenuPrimitive.Portal container={portalRoot}>
      <DropdownMenuPrimitive.Content
        className="board-menu"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
};
