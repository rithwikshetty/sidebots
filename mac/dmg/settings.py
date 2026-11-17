# How dmgbuild lays out the Sidebots disk image: the app beside a link to
# Applications, on a background with an arrow from one to the other, in a
# window with nothing else in it. `mac/build.sh release` passes the app's path
# and the background's.
app = defines["app"]

format = "UDZO"
files = [app]
symlinks = {"Applications": "/Applications"}

background = defines["background"]
window_rect = ((200, 200), (640, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
icon_size = 128
text_size = 13
icon_locations = {"Sidebots.app": (170, 190), "Applications": (470, 190)}
