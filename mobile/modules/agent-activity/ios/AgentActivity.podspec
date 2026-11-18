Pod::Spec.new do |s|
  s.name           = 'AgentActivity'
  s.version        = '0.1.0'
  s.summary        = 'Starts and ends the Live Activity that shows a working agent.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Sidebots'
  s.homepage       = 'https://github.com/rithwikshetty/sidebots'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
  # AgentActivityAttributes.swift is a link to the widget's own file, so the app and the widget can't describe the activity differently.
  s.source_files = "**/*.swift"
end
