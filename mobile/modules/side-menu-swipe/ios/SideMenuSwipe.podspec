Pod::Spec.new do |s|
  s.name           = 'SideMenuSwipe'
  s.version        = '0.1.0'
  s.summary        = "Makes a list's scroll wait for the side menu's swipe to decide."
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Sidebots'
  s.homepage       = 'https://github.com/rithwikshetty/sidebots'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: '' }
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
  s.source_files = "**/*.swift"
end
