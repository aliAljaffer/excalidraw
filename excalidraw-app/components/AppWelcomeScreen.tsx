import { gridIcon } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { WelcomeScreen } from "@excalidraw/excalidraw/index";
import React, { useSyncExternalStore } from "react";

import { IS_PRIVATE_ENTRY } from "../app_constants";
import {
  getBoardSessionSnapshot,
  subscribeBoardSession,
} from "../data/boardSession";

export const AppWelcomeScreen: React.FC<{
  onCollabDialogOpen: () => any;
  onBoardGalleryOpen: () => void;
  isCollabEnabled: boolean;
}> = React.memo((props) => {
  const { t } = useI18n();
  const board = useSyncExternalStore(
    subscribeBoardSession,
    getBoardSessionSnapshot,
    getBoardSessionSnapshot,
  );

  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        {t("welcomeScreen.app.menuHint")}
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo />
        <WelcomeScreen.Center.Heading>
          {board ? (
            "Pick a tool and start drawing."
          ) : (
            <>
              {t("welcomeScreen.app.center_heading")}
              <br />
              {t("welcomeScreen.app.center_heading_line2")}
              <br />
              {t("welcomeScreen.app.center_heading_line3")}
            </>
          )}
        </WelcomeScreen.Center.Heading>
        {!board && (
          <WelcomeScreen.Center.Menu>
            {IS_PRIVATE_ENTRY && (
              <WelcomeScreen.Center.MenuItemLink
                href="/"
                shortcut={null}
                icon={gridIcon}
                onClick={(event) => {
                  event.preventDefault();
                  props.onBoardGalleryOpen();
                }}
              >
                {t("labels.boards")}
              </WelcomeScreen.Center.MenuItemLink>
            )}
            <WelcomeScreen.Center.MenuItemLoadScene />
            <WelcomeScreen.Center.MenuItemHelp />
            {props.isCollabEnabled && (
              <WelcomeScreen.Center.MenuItemLiveCollaborationTrigger
                onSelect={() => props.onCollabDialogOpen()}
              />
            )}
          </WelcomeScreen.Center.Menu>
        )}
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
});
