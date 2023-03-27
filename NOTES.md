zip up dependencies for aws layer (run from parent dir):

```
zip -r -X deps.zip hearsay-lambdas -x "*/tmp/*" -x "*/layers/*" -x "*/lambda-*" -x "*/\.*"
mv deps.zip hearsay-lambdas/layers
```
