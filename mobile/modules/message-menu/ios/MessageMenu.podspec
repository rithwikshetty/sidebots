Pod::Spec.new do |s|
  s.name           = 'MessageMenu'
  s.version        = '0.1.0'
  s.summary        = 'The iOS menu a tap on a menu button opens.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Simon'
  s.homepage       = 'https://github.com/rithwikshetty/simon'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
  s.source_files = "**/*.swift"
end
